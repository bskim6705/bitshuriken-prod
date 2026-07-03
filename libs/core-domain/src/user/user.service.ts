import { Injectable, HttpStatus } from '@nestjs/common';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

const FEE_CACHE_TTL_MS = 60_000;

export interface FeeRates {
  makerBps: number;
  takerBps: number;
}

interface FeeCacheEntry extends FeeRates {
  expiresAt: number;
}

@Injectable()
export class UserService {
  private readonly feeCache = new Map<string, FeeCacheEntry>();

  constructor(private prisma: PrismaService) {}

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

  /** 계정 거래 제한 게이트 — admin이 tradingEnabled를 끄면 신규 주문 거부. DB 라이브 조회(즉시 효력). */
  async assertCanTrade(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tradingEnabled: true },
    });
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
