import { Injectable, HttpStatus } from '@nestjs/common';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { TotpService } from '../totp/totp.service';
import { EncryptionService } from '../crypto/encryption.service';

/** 2FA 강제 검사에 필요한 user 필드. */
export interface TwoFactorState {
  twoFactorEnabled: boolean;
  twoFactorSecret: string | null;
}

/**
 * TOTP 2FA 라이프사이클 + 강제 검사 (ADR-044). secret은 암호문으로 보관.
 * setup → enable(코드 확인) → 이후 민감 작업에서 assert.
 */
@Injectable()
export class TwoFactorService {
  constructor(
    private prisma: PrismaService,
    private totp: TotpService,
    private enc: EncryptionService,
  ) {}

  /** 비밀키 생성 + 암호문 저장(미활성). otpauth URI + QR 반환 (secret은 setup 응답 1회 노출). */
  async setup(userId: string, accountEmail: string) {
    const user = await this.getState(userId);
    if (user.twoFactorEnabled) {
      throw new DomainException(
        ErrorCode.TWO_FACTOR_ALREADY_ENABLED,
        '2FA is already enabled',
        HttpStatus.CONFLICT,
      );
    }
    const secret = this.totp.generateSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: this.enc.encrypt(secret) },
    });
    const otpauthUrl = this.totp.otpauthUrl(accountEmail, secret);
    return { secret, otpauthUrl, qrDataUrl: await this.totp.qrDataUrl(otpauthUrl) };
  }

  /** setup된 secret에 대해 코드를 확인하고 활성화. */
  async enable(userId: string, code: string): Promise<void> {
    const user = await this.getState(userId);
    if (user.twoFactorEnabled) {
      throw new DomainException(
        ErrorCode.TWO_FACTOR_ALREADY_ENABLED,
        '2FA is already enabled',
        HttpStatus.CONFLICT,
      );
    }
    if (!user.twoFactorSecret) {
      throw new DomainException(
        ErrorCode.TWO_FACTOR_NOT_ENABLED,
        'Run 2FA setup first',
        HttpStatus.CONFLICT,
      );
    }
    this.verifyCode(user.twoFactorSecret, code);
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: true },
    });
  }

  /** 유효한 코드 확인 후 비활성화 + secret 삭제. */
  async disable(userId: string, code: string): Promise<void> {
    const user = await this.getState(userId);
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new DomainException(
        ErrorCode.TWO_FACTOR_NOT_ENABLED,
        '2FA is not enabled',
        HttpStatus.CONFLICT,
      );
    }
    this.verifyCode(user.twoFactorSecret, code);
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: false, twoFactorSecret: null },
    });
  }

  /** 민감 작업 게이트(DB 조회). 2FA 미사용이면 통과, 사용이면 유효 코드 필수. */
  async assertSatisfied(userId: string, code?: string): Promise<void> {
    this.assertForUser(await this.getState(userId), code);
  }

  /** 호출자가 user를 이미 들고 있을 때(예: 로그인) 추가 조회 없이 검사. */
  assertForUser(user: TwoFactorState, code?: string): void {
    if (!user.twoFactorEnabled) return;
    // enabled인데 secret 부재 = 데이터 불일치. fail-open 대신 fail-closed로 거부.
    if (!user.twoFactorSecret) {
      throw new DomainException(
        ErrorCode.TWO_FACTOR_REQUIRED,
        'Two-factor is misconfigured for this account',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (!code) {
      throw new DomainException(
        ErrorCode.TWO_FACTOR_REQUIRED,
        'Two-factor code required',
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.verifyCode(user.twoFactorSecret, code);
  }

  private verifyCode(encryptedSecret: string, code: string): void {
    let secret: string;
    try {
      secret = this.enc.decrypt(encryptedSecret);
    } catch {
      // 손상/변조된 암호문 → 깨끗한 401 (raw crypto 500 방지)
      throw new DomainException(
        ErrorCode.INVALID_TWO_FACTOR_CODE,
        'Invalid two-factor code',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (!this.totp.verify(code, secret)) {
      throw new DomainException(
        ErrorCode.INVALID_TWO_FACTOR_CODE,
        'Invalid two-factor code',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  private async getState(userId: string): Promise<TwoFactorState> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { twoFactorEnabled: true, twoFactorSecret: true },
    });
    if (!user) {
      throw new DomainException(ErrorCode.USER_NOT_FOUND, 'User not found', HttpStatus.NOT_FOUND);
    }
    return user;
  }
}
