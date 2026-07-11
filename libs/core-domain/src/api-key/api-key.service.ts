import { Injectable, HttpStatus } from '@nestjs/common';
import { ApiKey } from '@prisma/client';
import * as crypto from 'crypto';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { EncryptionService } from '../crypto/encryption.service';
import { TwoFactorService } from '../two-factor/two-factor.service';

const API_KEY_BYTES = 24;
const API_SECRET_BYTES = 32;

export interface IssuedApiKey {
  id: string;
  apiKey: string;
  /** plaintext. 발급 직후 1회만 응답에 포함. Phase 2까지는 DB에도 plaintext. */
  secret: string;
  label: string | null;
  canTrade: boolean;
  canRead: boolean;
  ipWhitelist: string[];
  expiresAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class ApiKeyService {
  constructor(
    private prisma: PrismaService,
    private enc: EncryptionService,
    private twoFactor: TwoFactorService,
  ) {}

  /**
   * 새 API key 발급. plaintext secret을 응답에 1회 포함.
   * Phase 1: secret이 DB에도 plaintext. Phase 2에 envelope encryption 필요.
   */
  async issue(
    userId: string,
    params: {
      label?: string;
      canTrade?: boolean;
      canRead?: boolean;
      ipWhitelist?: string[];
      expiresInDays?: number;
      totpCode?: string;
    },
  ): Promise<IssuedApiKey> {
    await this.twoFactor.assertSatisfied(userId, params.totpCode);

    const apiKey = crypto.randomBytes(API_KEY_BYTES).toString('base64url');
    const secret = crypto.randomBytes(API_SECRET_BYTES).toString('base64url');
    const expiresAt =
      params.expiresInDays !== undefined
        ? new Date(Date.now() + params.expiresInDays * 24 * 60 * 60 * 1000)
        : null;

    const created = await this.prisma.apiKey.create({
      data: {
        userId,
        apiKey,
        secretEncrypted: this.enc.encrypt(secret),
        label: params.label ?? null,
        canTrade: params.canTrade ?? false,
        canRead: params.canRead ?? true,
        ipWhitelist: params.ipWhitelist ?? [],
        expiresAt,
      },
    });

    return {
      id: created.id,
      apiKey: created.apiKey,
      secret,
      label: created.label,
      canTrade: created.canTrade,
      canRead: created.canRead,
      ipWhitelist: created.ipWhitelist,
      expiresAt: created.expiresAt,
      createdAt: created.createdAt,
    };
  }

  /**
   * 사용자의 활성 API key 목록 (revoked 제외, secret 미포함).
   */
  listForUser(userId: string) {
    return this.prisma.apiKey.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        apiKey: true,
        label: true,
        canTrade: true,
        canRead: true,
        ipWhitelist: true,
        expiresAt: true,
        createdAt: true,
        lastUsedAt: true,
      },
    });
  }

  /**
   * Soft delete via revokedAt. 다른 user의 키는 revoke 불가. 멱등.
   */
  async revoke(userId: string, apiKeyId: string): Promise<void> {
    const key = await this.prisma.apiKey.findUnique({ where: { id: apiKeyId } });
    if (!key)
      throw new DomainException(
        ErrorCode.API_KEY_NOT_FOUND,
        'API key not found',
        HttpStatus.NOT_FOUND,
      );
    if (key.userId !== userId)
      throw new DomainException(ErrorCode.FORBIDDEN, 'Not your API key', HttpStatus.FORBIDDEN);
    if (key.revokedAt) return;
    await this.prisma.apiKey.update({
      where: { id: apiKeyId },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * 가드용: HMAC signature 검증.
   * canonical string = queryString + body. Binance와 동일.
   * timing-safe 비교로 timing attack 방지.
   */
  async verifySignature(params: {
    apiKey: string;
    queryString: string;
    body: string;
    providedSignature: string;
    ip?: string;
  }): Promise<ApiKey> {
    const record = await this.prisma.apiKey.findUnique({
      where: { apiKey: params.apiKey },
    });
    if (!record || record.revokedAt) {
      throw new DomainException(
        ErrorCode.INVALID_API_KEY,
        'Invalid API key',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // 만료 확인 — HMAC 계산 전(값싼 게이트).
    if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
      throw new DomainException(
        ErrorCode.API_KEY_EXPIRED,
        'API key has expired',
        HttpStatus.UNAUTHORIZED,
      );
    }

    let secret: string;
    try {
      secret = this.enc.decrypt(record.secretEncrypted);
    } catch {
      // 손상/변조된 암호문 → 깨끗한 401 (raw crypto 500 방지)
      throw new DomainException(
        ErrorCode.INVALID_API_KEY,
        'Invalid API key',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const expected = crypto
      .createHmac('sha256', secret)
      .update(params.queryString + params.body)
      .digest('hex');

    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(params.providedSignature, 'hex');
    if (
      expectedBuf.length !== providedBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, providedBuf)
    ) {
      throw new DomainException(
        ErrorCode.INVALID_SIGNATURE,
        'Invalid signature',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // IP allowlist — 서명 검증 후(빈 배열 = 무제한). 정당한 키 소유자에게만 IP 제약을 노출.
    if (record.ipWhitelist.length > 0 && (!params.ip || !record.ipWhitelist.includes(params.ip))) {
      throw new DomainException(
        ErrorCode.API_KEY_IP_REJECTED,
        'Request IP is not allowed for this API key',
        HttpStatus.UNAUTHORIZED,
      );
    }

    void this.touchLastUsed(record.id);
    return record;
  }

  private touchLastUsed(id: string): Promise<unknown> {
    return this.prisma.apiKey.update({
      where: { id },
      data: { lastUsedAt: new Date() },
    });
  }
}
