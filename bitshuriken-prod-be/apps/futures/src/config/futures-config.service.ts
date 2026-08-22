import { Injectable } from '@nestjs/common';
import { FuturesConfig } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';

@Injectable()
export class FuturesConfigService {
  private readonly cache = new Map<string, FuturesConfig>();

  constructor(private prisma: PrismaService) {}

  /** 심볼별 futures 정책 로드 (1회 캐시). 행 없음/invariant 위반은 throw — 임의 디폴트 금지. */
  async configOf(symbol: string): Promise<FuturesConfig> {
    const cached = this.cache.get(symbol);
    if (cached) return cached;

    const config = await this.prisma.futuresConfig.findUnique({
      where: { tickerSymbol: symbol },
    });
    if (!config) throw new Error(`FuturesConfig not found for ${symbol}`);

    // 초기마진율(1/maxLeverage)이 유지마진율+청산수수료율보다 커야 청산이 파산 전에 성립
    const initialMarginRate = new Decimal(1).div(config.maxLeverage);
    if (initialMarginRate.lte(config.mmr.add(config.liquidationFeeRate))) {
      throw new Error(
        `FuturesConfig invariant violated for ${symbol}: 1/maxLeverage must be > mmr + liquidationFeeRate`,
      );
    }

    this.cache.set(symbol, config);
    return config;
  }
}
