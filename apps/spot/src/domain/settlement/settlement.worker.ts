import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  MarketType,
  SettlementEvent,
  SettlementKind,
  SettlementStatus,
  Wallet,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { BalanceSnapshot, UserStreamService } from '../user-stream/user-stream.service';
import { OrderLeg, WalletLeg } from './settlement.types';

const BATCH_SIZE = 500;

@Injectable()
export class SettlementWorker {
  private readonly logger = new Logger(SettlementWorker.name);
  private running = false;

  constructor(
    private prisma: PrismaService,
    private userStream: UserStreamService,
  ) {}

  @Interval(100)
  async tick(): Promise<void> {
    if (this.running) return; // 이전 tick이 아직 처리 중이면 skip
    this.running = true;
    try {
      await this.drain();
    } catch (e) {
      this.logger.error('settlement worker tick failed', e as Error);
    } finally {
      this.running = false;
    }
  }

  private async drain(): Promise<void> {
    const pending = await this.prisma.settlementEvent.findMany({
      where: {
        status: SettlementStatus.PENDING,
        // spot worker 소관 kind만 — 그 외(futures 등)는 전용 worker가 처리
        kind: { in: [SettlementKind.TRADE, SettlementKind.DUST_REFUND] },
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
    });

    // (userId, asset, market)별 최신 wallet row — 잔고는 tx 안에서 캡처 (사후 SELECT 금지).
    const latest = new Map<string, Wallet>();

    for (const event of pending) {
      try {
        const wallets = await this.apply(event);
        for (const w of wallets) {
          const key = `${w.userId}:${w.assetSymbol}:${w.marketType}`;
          const prev = latest.get(key);
          if (!prev || w.updatedAt >= prev.updatedAt) latest.set(key, w);
        }
      } catch (e) {
        this.logger.error(`failed to apply settlement event ${event.id}`, e as Error);
        // 다음 cycle에서 재시도. PENDING으로 남음.
      }
    }

    if (latest.size === 0) return;

    const byUser = new Map<string, BalanceSnapshot[]>();
    for (const w of latest.values()) {
      let snapshots = byUser.get(w.userId);
      if (!snapshots) {
        snapshots = [];
        byUser.set(w.userId, snapshots);
      }
      snapshots.push({
        asset: w.assetSymbol,
        free: w.balance.toFixed(8),
        locked: w.locked.toFixed(8),
        ts: w.updatedAt.getTime(),
      });
    }
    for (const [userId, balances] of byUser) {
      this.userStream.emitAccountPosition(userId, balances);
    }
  }

  /** event 1건 적용. 갱신된 wallet row들을 반환 (commit 후 스냅샷 emit용). */
  private async apply(event: SettlementEvent): Promise<Wallet[]> {
    // 예상 밖 kind/leg는 throw — 조용히 적용하면 정산 유실
    if (event.kind !== SettlementKind.TRADE && event.kind !== SettlementKind.DUST_REFUND) {
      throw new Error(`event ${event.id}: unexpected kind ${event.kind}`);
    }
    const legs = parseWalletLegs(event);
    const orderLegs = parseOrderLegs(event);
    const updatedWallets: Wallet[] = [];

    await this.prisma.$transaction(async (tx) => {
      // race 방지: PENDING → APPLIED 전이가 0건이면 다른 인스턴스/이전 cycle이 이미 처리.
      const claim = await tx.settlementEvent.updateMany({
        where: { id: event.id, status: SettlementStatus.PENDING },
        data: { status: SettlementStatus.APPLIED, appliedAt: new Date() },
      });
      if (claim.count === 0) {
        throw new Error(`event ${event.id} already claimed`);
      }

      for (const leg of legs) {
        const lockedDelta = new Decimal(leg.lockedDelta);
        const balanceDelta = new Decimal(leg.balanceDelta);
        const key = {
          userId: leg.userId,
          assetSymbol: leg.assetSymbol,
          marketType: leg.marketType,
        };
        // 순수 credit leg(첫 수령 자산)는 행이 없을 수 있다 — upsert로 1회 생성.
        // 차감이 섞인 leg에서 행 부재는 회계 불변식 위반 — update가 throw (조용한 음수 행 생성 금지).
        const isCreditOnly = lockedDelta.gte(0) && balanceDelta.gte(0);
        const wallet = isCreditOnly
          ? await tx.wallet.upsert({
              where: { userId_assetSymbol_marketType: key },
              create: { ...key, balance: balanceDelta, locked: lockedDelta },
              update: {
                locked: { increment: lockedDelta },
                balance: { increment: balanceDelta },
              },
            })
          : await tx.wallet.update({
              where: { userId_assetSymbol_marketType: key },
              data: {
                locked: { increment: lockedDelta },
                balance: { increment: balanceDelta },
              },
            });
        updatedWallets.push(wallet);
      }

      for (const ol of orderLegs) {
        await tx.order.update({
          where: { id: ol.orderId },
          data: {
            executedQty: { increment: new Decimal(ol.executedQtyDelta) },
            cumulativeQuoteQty: { increment: new Decimal(ol.cumulativeQuoteQtyDelta) },
          },
        });
      }
    });

    return updatedWallets;
  }
}

/** legs 형태 검증 — 모르는 형태면 throw (PENDING 유지, 조용한 유실 방지). */
function parseWalletLegs(event: SettlementEvent): WalletLeg[] {
  if (!Array.isArray(event.legs)) {
    throw new Error(`event ${event.id}: legs must be an array`);
  }
  return event.legs.map((raw, i) => {
    const leg = raw as Record<string, unknown> | null;
    const valid =
      leg !== null &&
      typeof leg === 'object' &&
      typeof leg.userId === 'string' &&
      typeof leg.assetSymbol === 'string' &&
      typeof leg.lockedDelta === 'string' &&
      typeof leg.balanceDelta === 'string' &&
      Object.values(MarketType).includes(leg.marketType as MarketType);
    if (!valid) {
      throw new Error(`event ${event.id}: unexpected wallet leg shape at [${i}]`);
    }
    return leg as unknown as WalletLeg;
  });
}

function parseOrderLegs(event: SettlementEvent): OrderLeg[] {
  if (!Array.isArray(event.orderLegs)) {
    throw new Error(`event ${event.id}: orderLegs must be an array`);
  }
  return event.orderLegs.map((raw, i) => {
    const leg = raw as Record<string, unknown> | null;
    const valid =
      leg !== null &&
      typeof leg === 'object' &&
      typeof leg.orderId === 'string' &&
      typeof leg.executedQtyDelta === 'string' &&
      typeof leg.cumulativeQuoteQtyDelta === 'string';
    if (!valid) {
      throw new Error(`event ${event.id}: unexpected order leg shape at [${i}]`);
    }
    return leg as unknown as OrderLeg;
  });
}
