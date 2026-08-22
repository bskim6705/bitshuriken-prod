import { Injectable, Logger } from '@nestjs/common';
import { BalanceJournalKind, MarketType } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { SourceKey } from './journal-writer';
import { LedgerAvailability } from './ledger-availability';
import { LedgerService } from './ledger.service';

export interface BaselineResult {
  market: MarketType;
  created: number;
  status: 'baselined' | 'already-baselined' | 'journal-not-empty' | 'disabled';
}

/**
 * 저널 이전의 역사적 잔고 이월. 원장은 저널 리플레이로 재구성되는데 기존 Wallet 행에는 저널 이전
 * 잔고가 있으므로, 활성화 시점에 지갑당 BASELINE 엔트리 1건(delta = 현재 balance/locked,
 * sourceKey baseline:{userId}:{asset}:{market})으로 저널에 옮긴다. 부트 시퀀스(listen 전)에서
 * 소유 마켓별 1회 — 이후 replayAll이 이 엔트리부터 원장을 재구성한다.
 *
 * 전제: 최초 활성화는 전 스택 quiesce 재기동 창(미러 정지 + 정산 PENDING=0)에서 수행 — 관례적
 * 재기동 레시피와 동일. 베이스라인 이후 생성되는 신규 지갑은 첫 저널 엔트리(DEPOSIT 등)가 0에서
 * 만들므로 커버된다.
 *
 * 마켓별 판정 (체크+기록 전부 단일 tx):
 *  - BASELINE 존재 → skip (1회성 마커).
 *  - BASELINE 없음 + 그 마켓 저널 엔트리 존재 → skip + error 로그. 이 상태에서 현재 Wallet 행을
 *    baseline하면 이미 저널에 기록된 델타가 리플레이에서 이중 계상된다(baseline이 그 델타를 이미
 *    포함). 활성화 레시피 위반 신호이며, 실제 격차는 DriftChecker가 노출한다.
 *  - 둘 다 없음 → 현재 Wallet 행 전체를 BASELINE으로 기록 (최초 활성화).
 */
@Injectable()
export class LedgerBaseliner {
  private readonly logger = new Logger(LedgerBaseliner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly availability: LedgerAvailability,
  ) {}

  /** 소유 마켓 전부 베이스라인 (소유 미지정 = 전 마켓). */
  async baseline(): Promise<BaselineResult[]> {
    const owned = this.ledger.ownedMarketList();
    const markets = owned.length > 0 ? owned : Object.values(MarketType);
    const results: BaselineResult[] = [];
    for (const market of markets) {
      results.push(await this.baselineMarket(market));
    }
    return results;
  }

  private async baselineMarket(market: MarketType): Promise<BaselineResult> {
    if (!this.availability.enabled) return { market, created: 0, status: 'disabled' };

    return this.prisma.$transaction(async (tx) => {
      const marker = await tx.balanceJournal.findFirst({
        where: { marketType: market, kind: BalanceJournalKind.BASELINE },
        select: { seq: true },
      });
      if (marker) return { market, created: 0, status: 'already-baselined' as const };

      const anyEntry = await tx.balanceJournal.findFirst({
        where: { marketType: market },
        select: { seq: true },
      });
      if (anyEntry) {
        this.logger.error(
          `baseline SKIPPED for ${market}: journal has entries but no BASELINE — baselining now ` +
            `would double-count journaled deltas on replay. If wallets predate the journal, the ` +
            `activation recipe (quiesced restart) was violated; DriftChecker will surface any gap.`,
        );
        return { market, created: 0, status: 'journal-not-empty' as const };
      }

      const wallets = await tx.wallet.findMany({ where: { marketType: market } });
      if (wallets.length > 0) {
        await tx.balanceJournal.createMany({
          data: wallets.map((w) => ({
            userId: w.userId,
            assetSymbol: w.assetSymbol,
            marketType: market,
            kind: BalanceJournalKind.BASELINE,
            deltaBalance: w.balance,
            deltaLocked: w.locked,
            sourceKey: SourceKey.baseline(w.userId, w.assetSymbol, market),
          })),
        });
      }
      this.logger.log(`baseline written for ${market}: ${wallets.length} wallet rows`);
      return { market, created: wallets.length, status: 'baselined' as const };
    });
  }
}
