import { CanActivate, ExecutionContext, Injectable, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ApiKeyService } from '../../api-key/api-key.service';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { ApiScope, API_SCOPE_KEY } from '@app/shared/decorators/api-scope.decorator';

const DEFAULT_RECV_WINDOW_MS = 5000;
const MAX_RECV_WINDOW_MS = 60_000;

/**
 * API key + HMAC signature 가드.
 *
 * 요구 사항:
 * - 헤더 X-API-KEY (public part)
 * - query 파라미터 timestamp (epoch ms)
 * - query 파라미터 signature (HMAC-SHA256(queryString + body, secret), hex)
 * - query 파라미터 recvWindow (선택, 기본 5000ms, 최대 60000ms)
 *
 * canonical string = queryString_without_signature + body
 *
 * 통과 시 req.user = { userId, email }.
 */
@Injectable()
export class ApiKeyOnlyGuard implements CanActivate {
  constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();

    const apiKey = req.header('x-api-key');
    if (!apiKey) {
      throw new DomainException(
        ErrorCode.AUTH_REQUIRED,
        'X-API-KEY header required',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // Express는 query를 객체로 파싱. 원본 raw query string은 req.url에서 추출.
    const rawUrl = req.originalUrl ?? req.url ?? '';
    const queryIdx = rawUrl.indexOf('?');
    const fullQuery = queryIdx >= 0 ? rawUrl.slice(queryIdx + 1) : '';

    const params = new URLSearchParams(fullQuery);
    const signature = params.get('signature');
    const timestampStr = params.get('timestamp');
    const recvWindowStr = params.get('recvWindow');

    if (!signature)
      throw new DomainException(ErrorCode.PARAM_REQUIRED, 'signature query param required');
    if (!timestampStr)
      throw new DomainException(ErrorCode.PARAM_REQUIRED, 'timestamp query param required');

    const timestamp = Number(timestampStr);
    if (!Number.isFinite(timestamp)) {
      throw new DomainException(ErrorCode.INVALID_PARAMETER, 'timestamp must be a number');
    }

    let recvWindow = DEFAULT_RECV_WINDOW_MS;
    if (recvWindowStr) {
      const n = Number(recvWindowStr);
      if (!Number.isFinite(n) || n <= 0) {
        throw new DomainException(
          ErrorCode.INVALID_PARAMETER,
          'recvWindow must be a positive number',
        );
      }
      recvWindow = Math.min(n, MAX_RECV_WINDOW_MS);
    }

    const skew = Math.abs(Date.now() - timestamp);
    if (skew > recvWindow) {
      throw new DomainException(
        ErrorCode.TIMESTAMP_OUT_OF_RECV_WINDOW,
        `Timestamp outside recvWindow (skew=${skew}ms, allowed=${recvWindow}ms)`,
        HttpStatus.UNAUTHORIZED,
      );
    }

    // signature를 query에서 제거한 canonical string. timestamp/recvWindow는 남겨둠.
    params.delete('signature');
    const queryStringForSign = params.toString();

    // body는 raw bytes. JSON parser가 이미 돌았으면 stringified 형태로 재구성 불가하므로
    // express의 raw body가 필요. main.ts에서 rawBody 옵션을 켜야 함.
    const body = (req as Request & { rawBody?: Buffer }).rawBody?.toString('utf8') ?? '';

    const record = await this.apiKeyService.verifySignature({
      apiKey,
      queryString: queryStringForSign,
      body,
      providedSignature: signature,
      ip: req.ip, // trust proxy 설정됨 → 실제 클라이언트 IP (ipWhitelist 대조)
    });

    // 권한 범위 강제 — endpoint 미지정 시 READ. TRADE는 canTrade, READ는 canRead 필요.
    const required =
      this.reflector.getAllAndOverride<ApiScope>(API_SCOPE_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? ApiScope.READ;
    if (required === ApiScope.TRADE && !record.canTrade) {
      throw new DomainException(
        ErrorCode.API_KEY_NO_TRADE_PERMISSION,
        'API key lacks trade permission',
        HttpStatus.FORBIDDEN,
      );
    }
    if (required === ApiScope.READ && !record.canRead) {
      throw new DomainException(
        ErrorCode.API_KEY_NO_READ_PERMISSION,
        'API key lacks read permission',
        HttpStatus.FORBIDDEN,
      );
    }

    // req.user 통일
    const user = await this.prisma.user.findUnique({
      where: { id: record.userId },
      select: { id: true, email: true, role: true, rateLimitExempt: true },
    });
    if (!user)
      throw new DomainException(
        ErrorCode.USER_NOT_FOUND,
        'User not found',
        HttpStatus.UNAUTHORIZED,
      );

    (req as Request & { user: unknown }).user = {
      userId: user.id,
      email: user.email,
      role: user.role,
      rateLimitExempt: user.rateLimitExempt,
    };
    return true;
  }
}
