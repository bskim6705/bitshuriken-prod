import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { RateLimitStore } from './rate-limit.store';
import type { RateLimitConfig } from './rate-limit.config';
import { RateLimitException, TooManyOrdersException } from './rate-limit.exception';
import { WeightResolver } from './weight.decorator';
import {
  WEIGHT_METADATA,
  ORDER_COUNT_METADATA,
  RATE_LIMIT_CONFIG,
  USED_WEIGHT_1M_HEADER,
  ORDER_COUNT_10S_HEADER,
  ORDER_COUNT_1D_HEADER,
  RETRY_AFTER_HEADER,
} from './rate-limit.constants';
import type { CurrentUserPayload } from '../decorators/current-user.decorator';

interface RlRequest {
  user?: CurrentUserPayload;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, unknown>;
}
interface RlResponse {
  setHeader(name: string, value: string): void;
}

const MINUTE = 60_000;
const TEN_SEC = 10_000;
const DAY = 86_400_000;

/**
 * Binance 스타일 weight limiter. 가드 뒤에 실행돼 req.user를 읽는다(주문은 userId 버킷).
 * 헤더는 항상 res에 직접 set(성공·거부 동일 경로). 강제는 config.enabled일 때만.
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: RateLimitStore,
    @Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitConfig,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<RlRequest>();
    const res = context.switchToHttp().getResponse<RlResponse>();
    try {
      this.apply(context, req, res);
    } catch (e) {
      if (e instanceof RateLimitException || e instanceof TooManyOrdersException) throw e;
      // 예상치 못한 내부 오류 → fail-open (요청 통과).
    }
    return next.handle();
  }

  private apply(context: ExecutionContext, req: RlRequest, res: RlResponse): void {
    if (this.isExempt(req)) return;

    const targets = [context.getHandler(), context.getClass()];
    const weightMeta =
      this.reflector.getAllAndOverride<WeightResolver>(WEIGHT_METADATA, targets) ?? 1;
    const weight = typeof weightMeta === 'function' ? weightMeta(req) : weightMeta;
    const orderN = this.reflector.getAllAndOverride<number>(ORDER_COUNT_METADATA, targets);

    const userId = req.user?.userId;
    const weightKey = userId ? `acct:${userId}` : `ip:${req.ip ?? 'unknown'}`;
    const now = Date.now();

    const usedWeight = this.store.addWeight(weightKey, weight, now);
    const usedRaw = this.store.addRaw(weightKey, now);
    res.setHeader(USED_WEIGHT_1M_HEADER, String(usedWeight));

    let order;
    if (orderN !== undefined && userId) {
      order = this.store.addOrder(`acct:${userId}`, orderN, now);
      res.setHeader(ORDER_COUNT_10S_HEADER, String(order.count10s));
      res.setHeader(ORDER_COUNT_1D_HEADER, String(order.count1d));
    }

    if (!this.config.enabled) return; // 헤더는 항상 방출, 강제는 플래그로.

    if (usedWeight > this.config.weightPerMin || usedRaw > this.config.rawPer5Min) {
      const retryAfter = Math.ceil((MINUTE - (now % MINUTE)) / 1000);
      res.setHeader(RETRY_AFTER_HEADER, String(retryAfter));
      throw new RateLimitException(
        usedRaw > this.config.rawPer5Min
          ? 'Raw request limit exceeded'
          : 'Request weight limit exceeded',
      );
    }
    if (order && (order.count10s > this.config.ordersPer10s || order.count1d > this.config.ordersPer1d)) {
      const overDaily = order.count1d > this.config.ordersPer1d;
      const retryAfter = overDaily
        ? Math.ceil((DAY - (now % DAY)) / 1000)
        : Math.ceil((TEN_SEC - (now % TEN_SEC)) / 1000);
      res.setHeader(RETRY_AFTER_HEADER, String(retryAfter));
      throw new TooManyOrdersException();
    }
  }

  private isExempt(req: RlRequest): boolean {
    // 시장 조성 계정(rateLimitExempt) — API 키 인증 경로에서 채워짐 (ADR-066)
    if (req.user?.rateLimitExempt === true) return true;
    const token = this.config.internalToken;
    return token !== '' && req.headers['x-internal-token'] === token;
  }
}
