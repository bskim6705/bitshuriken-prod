import { Injectable, HttpStatus } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { TtlLruCache } from '../cache/ttl-lru-cache';

const FEE_CACHE_TTL_MS = 60_000;

// 인증 핫패스: 가드의 user 로드와 assertCanTrade가 공유하는 짧은 TTL 캐시.
// tradingEnabled/역할 등 반영은 ≤TTL 지연 수용 (admin 토글 즉시성 트레이드오프).
const AUTH_CTX_CACHE_TTL_MS = 5_000;
const AUTH_CTX_CACHE_MAX = 10_000;

export interface FeeRates {
  makerBps: number;
  takerBps: number;
}

interface FeeCacheEntry extends FeeRates {
  expiresAt: number;
}

/** 가드/주문 게이트가 함께 쓰는 인증 컨텍스트. 요청당 user 이중 read 제거용. */
export interface AuthContext {
  id: string;
  email: string;
  role: UserRole;
  rateLimitExempt: boolean;
  tradingEnabled: boolean;
}

@Injectable()
export class UserService {
  private readonly feeCache = new Map<string, FeeCacheEntry>();
  private readonly authCache = new TtlLruCache<AuthContext>(
    AUTH_CTX_CACHE_TTL_MS,
    AUTH_CTX_CACHE_MAX,
  );

  constructor(private prisma: PrismaService) {}

  /**
   * 인증 컨텍스트 로드 (짧은 TTL 캐시). 가드가 채우면 같은 요청의 assertCanTrade가 재조회 0.
   * 없는 유저는 null 반환 — 호출부가 문맥에 맞는 상태코드로 throw (가드 401 / 주문게이트 404).
   */
  async authContextOf(userId: string): Promise<AuthContext | null> {
    const now = Date.now();
    const cached = this.authCache.get(userId, now);
    if (cached) return cached;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        rateLimitExempt: true,
        tradingEnabled: true,
      },
    });
    if (!user) return null;
    this.authCache.set(userId, user, now);
    return user;
  }

  findOne(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, createdAt: true },
    });
  }

  /** 수수료 요율 조회 (60s TTL 캐시). 유저 없음/범위 위반은 throw — 기본값 대체 금지. */
  async feeRatesOf(userId: string): Promise<FeeRates> {
    const cached = this.feeCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return { makerBps: cached.makerBps, takerBps: cached.takerBps };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { feeMakerBps: true, feeTakerBps: true },
    });
    if (!user)
      throw new DomainException(
        ErrorCode.USER_NOT_FOUND,
        `User ${userId} not found`,
        HttpStatus.NOT_FOUND,
      );

    for (const [field, bps] of [
      ['feeMakerBps', user.feeMakerBps],
      ['feeTakerBps', user.feeTakerBps],
    ] as const) {
      if (!Number.isInteger(bps) || bps < 0 || bps >= 10000) {
        throw new Error(`User ${userId} has invalid ${field}=${bps} (must be in [0, 10000))`);
      }
    }

    const rates: FeeRates = { makerBps: user.feeMakerBps, takerBps: user.feeTakerBps };
    this.feeCache.set(userId, { ...rates, expiresAt: Date.now() + FEE_CACHE_TTL_MS });
    return rates;
  }

  /**
   * 계정 거래 제한 게이트 — admin이 tradingEnabled를 끄면 신규 주문 거부.
   * authContextOf 캐시 재사용 → 가드가 이미 로드한 요청은 재조회 0. 반영 ≤TTL 지연.
   */
  async assertCanTrade(userId: string): Promise<void> {
    const user = await this.authContextOf(userId);
    if (!user)
      throw new DomainException(ErrorCode.USER_NOT_FOUND, 'User not found', HttpStatus.NOT_FOUND);
    if (!user.tradingEnabled)
      throw new DomainException(
        ErrorCode.ACCOUNT_TRADING_DISABLED,
        'Trading is disabled for this account',
        HttpStatus.FORBIDDEN,
      );
  }
}
