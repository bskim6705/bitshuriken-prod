import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MarketType, Prisma, SettlementKind } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { FuturesConfigService } from '../config/futures-config.service';
import { MarkPriceService } from '../mark-price/mark-price.service';
import { InsuranceFundService } from '../settlement/insurance-fund.service';
import { buildFundingBatch, computeFundingRate } from './funding-math';

// 펀딩 주기 8h (UTC 00/08/16) — 코드 상수
const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000;
const ZERO = new Decimal(0);
// 일시 오류 1회로 8h 라운드가 영구 누락되지 않도록 같은 fundingTime으로 재시도
const SETTLE_MAX_ATTEMPTS = 3;
const SETTLE_RETRY_DELAY_MS = 2000;

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 8h 펀딩 정산 — rate 산출 → FundingRate insert → qty≠0 스냅샷 → 유저별 FUNDING event append.
 * 잔고 반영은 정산 worker 몫. 심볼당 단일 트랜잭션이라 부분 적용 상태가 없고,
 * FundingRate @@unique가 배치 전체의 멱등 가드 (같은 fundingTime 재실행 시 P2002 → skip).
 */
@Injectable()
export class FundingScheduler {
  private readonly logger = new Logger(FundingScheduler.name);

  constructor(
    private prisma: PrismaService,
    private markPrice: MarkPriceService,
    private futuresConfig: FuturesConfigService,
    private insuranceFund: InsuranceFundService,
  ) {}

  @Cron('0 0 0,8,16 * * *', { timeZone: 'UTC' })
  async settle(): Promise<void> {
    // cron 발화 지터를 8h 경계로 정규화
    const fundingTime = new Date(
      Math.round(Date.now() / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS,
    );
    const tickers = await this.prisma.ticker.findMany({
      where: { marketType: MarketType.FUTURES },
      select: { symbol: true },
    });
    for (const { symbol } of tickers) {
      try {
        await this.settleSymbol(symbol, fundingTime);
      } catch (e) {
        // 심볼 간 독립 — 한 심볼 실패가 나머지 정산을 막지 않는다
        this.logger.error(
          `funding settlement failed for ${symbol} @ ${fundingTime.toISOString()}`,
          e as Error,
        );
      }
    }
  }

  private async settleSymbol(symbol: string, fundingTime: Date): Promise<void> {
    const ts = fundingTime.toISOString();
    // 드레인한 샘플은 보관 — 이후 단계 실패 시 같은 윈도우로 재시도 (유실 방지)
    let samples: Decimal[] | null = null;
    let lastError: unknown;

    for (let attempt = 1; attempt <= SETTLE_MAX_ATTEMPTS; attempt++) {
      try {
        const mark = this.markPrice.getMark(symbol); // mark 미정의면 throw (fail loudly)
        const config = await this.futuresConfig.configOf(symbol);
        const fundUserId = await this.insuranceFund.userId();
        samples ??= this.markPrice.drainPremiumSamples(symbol);
        const rate = computeFundingRate(samples, config.fundingCap);

        await this.prisma.$transaction(async (tx) => {
          await tx.fundingRate.create({
            data: { tickerSymbol: symbol, fundingTime, rate, markPrice: mark },
          });

          // qty≠0 전수 — LIQUIDATING·보험기금 포함이어야 zero-sum 성립
          const positions = await tx.position.findMany({
            where: { tickerSymbol: symbol, qty: { not: ZERO } },
            select: { userId: true, qty: true },
          });
          if (positions.length === 0) return;

          const batch = buildFundingBatch(symbol, rate, mark, positions, fundUserId);
          for (const leg of batch.legs) {
            await tx.settlementEvent.create({
              data: {
                sourceKey: `funding:${symbol}:${ts}:${leg.userId}`,
                kind: SettlementKind.FUNDING,
                legs: [leg] as unknown as Prisma.InputJsonValue,
                orderLegs: [] as unknown as Prisma.InputJsonValue,
              },
            });
          }
          if (batch.dustLeg) {
            await tx.settlementEvent.create({
              data: {
                sourceKey: `funding:${symbol}:${ts}:dust`,
                kind: SettlementKind.FUNDING,
                legs: [batch.dustLeg] as unknown as Prisma.InputJsonValue,
                orderLegs: [] as unknown as Prisma.InputJsonValue,
              },
            });
          }
        });
        this.logger.log(`funding settled: ${symbol} @ ${ts} rate=${rate.toFixed()}`);
        return;
      } catch (e) {
        if (isUniqueViolation(e)) {
          this.logger.warn(`funding already settled: ${symbol} @ ${ts} — skip`);
          return;
        }
        lastError = e;
        if (attempt < SETTLE_MAX_ATTEMPTS) {
          this.logger.warn(
            `funding attempt ${attempt}/${SETTLE_MAX_ATTEMPTS} failed for ${symbol} @ ${ts} — retry`,
          );
          await sleep(SETTLE_RETRY_DELAY_MS);
        }
      }
    }
    throw lastError;
  }
}
