import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  BalanceJournal,
  BalanceJournalKind,
  MarketType,
  Prisma,
  SettlementEvent,
  SettlementKind,
  SettlementStatus,
  Wallet,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { SETTLEMENT_MAX_ATTEMPTS } from '@app/shared/constants/settlement';
import { JournalWriter } from '@app/core-domain/ledger/journal-writer';
import { JournalInput } from '@app/core-domain/ledger/ledger.types';
import { LedgerService } from '@app/core-domain/ledger/ledger.service';
import { LedgerAvailability } from '@app/core-domain/ledger/ledger-availability';
import { LEDGER_TRUTH } from '@app/core-domain/ledger/ledger-truth';
import { toEntry } from '@app/core-domain/ledger/journal-tailer';
import { BalanceSnapshot, UserStreamService } from '../user-stream/user-stream.service';
import { OrderLeg, WalletLeg } from './settlement.types';

const BATCH_SIZE = 500;

@Injectable()
export class SettlementWorker implements OnApplicationShutdown {
  private readonly logger = new Logger(SettlementWorker.name);
  private readonly failCounts = new Map<string, number>(); // eventId → 연속 적용 실패 횟수 (ADR-067)
  private running = false;
  private stopping = false;

  /** 종료 시퀀스: 새 tick 차단 후 진행 중 tick의 tx가 끝날 때까지 대기 — 정산이 중간에 찢기지 않는다. */
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    const deadline = Date.now() + 15_000;
    while (this.running && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.running) this.logger.error('shutdown: settlement tick still running after 15s grace');
    else this.logger.log('settlement worker quiesced');
  }

  constructor(
    private prisma: PrismaService,
    private userStream: UserStreamService,
    private journal: JournalWriter,
    private ledger: LedgerService,
    private availability: LedgerAvailability,
  ) {}

  /** S2 진실 경로 판정: 스위치 ON + 저널 가용(테이블 부재면 S0 행 경로로 안전 강등). */
  private useTruth(): boolean {
    return LEDGER_TRUTH && this.availability.enabled;
  }

  @Interval(100)
  async tick(): Promise<void> {
    if (this.running || this.stopping) return; // 이전 tick 처리 중 / 종료 시퀀스 중이면 skip
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
    if (pending.length === 0) return;

    // fast path: 배치를 tx 1개로 델타 합산 적용. 예기치 못한 throw면 per-event 폴백
    // (recordFailure/quarantine 시맨틱 100% 보존). 둘 다 (userId,asset,market)별 최신 wallet 반환.
    let latest: Map<string, Wallet>;
    try {
      latest = await this.applyBatch(pending);
    } catch (e) {
      this.logger.error('settlement fast-path failed — falling back to per-event apply', e as Error);
      latest = await this.applyPerEvent(pending);
    }

    this.emitSnapshots(latest);
  }

  /** per-event 폴백: 이벤트별 독립 tx. poison은 recordFailure로 격리 (기존 동작 그대로). */
  private async applyPerEvent(pending: SettlementEvent[]): Promise<Map<string, Wallet>> {
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
        // PENDING으로 남아 다음 cycle 재시도. 반복 실패(poison)는 격리 + DeadLetter 사본 (ADR-067).
        await this.recordFailure(event, e as Error);
      }
    }
    return latest;
  }

  /**
   * fast path: 배치 전체를 tx 1개로 적용.
   * ⓐ FOR UPDATE SKIP LOCKED로 PENDING 후보 잠금(경합 워커와 안전) → ⓑ 차감 leg 대상 wallet 행
   * 부재 이벤트를 제외(제외분은 PENDING 유지→per-event가 다음 tick 처리·격리) → ⓒ 적용분만
   * APPLIED claim → ⓓ wallet/order 델타 키별 1회 적용. throw는 그대로 위로 던져 폴백을 유도.
   */
  private async applyBatch(pending: SettlementEvent[]): Promise<Map<string, Wallet>> {
    const parsed: ParsedEvent[] = pending.map((e) => ({
      id: e.id,
      walletLegs: parseWalletLegs(e), // poison이면 throw → 폴백
      orderLegs: parseOrderLegs(e),
    }));
    const eventById = new Map(pending.map((e) => [e.id, e] as const));

    const latest = new Map<string, Wallet>();
    const journalRows: BalanceJournal[] = [];
    await this.prisma.$transaction(async (tx) => {
      const lockedRows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "SettlementEvent"
         WHERE "id" IN (${Prisma.join(parsed.map((p) => p.id))})
           AND "status" = 'PENDING'::"SettlementStatus"
        FOR UPDATE SKIP LOCKED`;
      const lockedIds = new Set(lockedRows.map((r) => r.id));
      const locked = parsed.filter((p) => lockedIds.has(p.id));
      if (locked.length === 0) return;

      const useTruth = this.useTruth();
      // 차감성 leg 대상 (userId,asset,market) 중 실제 행이 없는 것 — 존재 확인은 tx 안에서.
      // S2: 잔고 진실이 원장이라 Wallet 행 존재 여부는 무의미(프로젝션) → 제외 없음.
      let absentDebitKeys = new Set<string>();
      if (!useTruth) {
        const debitKeys = debitKeysOf(locked);
        const existing =
          debitKeys.length === 0
            ? []
            : await tx.wallet.findMany({
                where: { OR: debitKeys },
                select: { userId: true, assetSymbol: true, marketType: true },
              });
        const existingSet = new Set(existing.map((w) => walletKey(w)));
        absentDebitKeys = new Set(
          debitKeys.map(walletKey).filter((k) => !existingSet.has(k)),
        );
      }

      const plan = planBatch(locked, absentDebitKeys);
      if (plan.appliedEventIds.length === 0) return;

      // 적용분만 APPLIED 전이 (제외분은 PENDING 유지).
      await tx.settlementEvent.updateMany({
        where: { id: { in: plan.appliedEventIds }, status: SettlementStatus.PENDING },
        data: { status: SettlementStatus.APPLIED, appliedAt: new Date() },
      });

      // S2: Wallet 행 UPDATE 없음(락 컨보이 소멸) — 커밋 후 저널을 원장에 반영, 스냅샷은 원장에서.
      if (!useTruth) {
        for (const d of plan.walletDeltas) {
          const key = { userId: d.userId, assetSymbol: d.assetSymbol, marketType: d.marketType };
          // 순수 credit 키만 upsert(첫 수령 자산 행 생성). 차감 포함 키는 update — 행 부재는
          // 위에서 이미 제외했으므로 여기 도달하는 차감 키의 행은 반드시 존재.
          const w = d.hasDebit
            ? await tx.wallet.update({
                where: { userId_assetSymbol_marketType: key },
                data: { locked: { increment: d.locked }, balance: { increment: d.balance } },
              })
            : await tx.wallet.upsert({
                where: { userId_assetSymbol_marketType: key },
                create: { ...key, balance: d.balance, locked: d.locked },
                update: { locked: { increment: d.locked }, balance: { increment: d.balance } },
              });
          latest.set(walletKey(w), w);
        }
      }

      for (const o of plan.orderDeltas) {
        await tx.order.update({
          where: { id: o.orderId },
          data: {
            executedQty: { increment: o.executedQty },
            cumulativeQuoteQty: { increment: o.cumulativeQuoteQty },
          },
        });
      }

      // S0 원장 섀도: 적용분만 이벤트×leg 단위로 저널 (합산 전 원본 leg — 합=집계델타라 드리프트 0).
      const applied = new Set(plan.appliedEventIds);
      const inputs: JournalInput[] = [];
      for (const pe of locked) {
        if (!applied.has(pe.id)) continue;
        const ev = eventById.get(pe.id);
        if (ev) pushSettlementJournalInputs(inputs, ev, pe.walletLegs);
      }
      journalRows.push(...(await this.journal.writeManyInTx(tx, inputs)));
    });

    this.applyJournalRowsLocally(journalRows);
    // S2: 스냅샷을 원장(진실)에서 — Wallet 행은 프로젝터가 뒤따라 반영.
    return this.useTruth() ? this.ledgerSnapshots(journalRows) : latest;
  }

  /** 최신 wallet 스냅샷을 유저별로 묶어 user-stream 발행. */
  private emitSnapshots(latest: Map<string, Wallet>): void {
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

  /**
   * 실패 기록: 인메모리 attempts 증가(워커 재시작 시 리셋 — poison은 threshold를 다시 채우고
   * 격리됨), SETTLEMENT_MAX_ATTEMPTS 도달 시 격리 + DeadLetter 사본.
   * DLQ 스키마 미적용(settlement-dlq 마이그레이션 전)이면 격리를 강등하고 기존 재시도 동작 유지.
   */
  private async recordFailure(event: SettlementEvent, err: Error): Promise<void> {
    const attempts = (this.failCounts.get(event.id) ?? 0) + 1;
    this.failCounts.set(event.id, attempts);
    if (attempts < SETTLEMENT_MAX_ATTEMPTS) {
      this.logger.error(
        `failed to apply settlement event ${event.id} (${event.kind}) — attempt ${attempts}/${SETTLEMENT_MAX_ATTEMPTS}, retrying`,
        err,
      );
      return;
    }
    try {
      // 격리 — 상태 전이와 사본 기록을 한 트랜잭션으로. PENDING이 아니면(경합 처리됨) no-op.
      const quarantined = await this.prisma.$transaction(async (tx) => {
        const claim = await tx.settlementEvent.updateMany({
          where: { id: event.id, status: SettlementStatus.PENDING },
          data: { status: SettlementStatus.QUARANTINED },
        });
        if (claim.count === 0) return false;
        await tx.settlementDeadLetter.create({
          data: {
            eventId: event.id,
            seq: event.seq,
            sourceKey: event.sourceKey,
            kind: event.kind,
            legs: event.legs as Prisma.InputJsonValue,
            orderLegs: event.orderLegs as Prisma.InputJsonValue,
            attempts,
            lastError: err.message,
          },
        });
        return true;
      });
      if (quarantined) {
        this.failCounts.delete(event.id);
        this.logger.error(
          `QUARANTINED settlement event ${event.id} (${event.kind}, seq=${event.seq}, ` +
            `sourceKey=${event.sourceKey}) after ${attempts} failed attempts — money movement NOT ` +
            `applied; see SettlementDeadLetter. lastError: ${err.message}`,
        );
      }
    } catch (dlqErr) {
      this.logger.error(
        `DLQ unavailable for event ${event.id} — run the settlement-dlq prisma migration; falling back to retry`,
        dlqErr as Error,
      );
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
    const journalRows: BalanceJournal[] = [];
    const useTruth = this.useTruth();

    await this.prisma.$transaction(async (tx) => {
      // race 방지: PENDING → APPLIED 전이가 0건이면 다른 인스턴스/이전 cycle이 이미 처리.
      const claim = await tx.settlementEvent.updateMany({
        where: { id: event.id, status: SettlementStatus.PENDING },
        data: { status: SettlementStatus.APPLIED, appliedAt: new Date() },
      });
      if (claim.count === 0) {
        throw new Error(`event ${event.id} already claimed`);
      }

      // S2: Wallet 행 UPDATE 없음 — 커밋 후 저널을 원장에 반영, 스냅샷은 원장에서.
      if (!useTruth) {
        for (const leg of legs) {
          const key = {
            userId: leg.userId,
            assetSymbol: leg.assetSymbol,
            marketType: leg.marketType,
          };
          // 순수 credit leg(첫 수령 자산)는 행이 없을 수 있다 — upsert로 1회 생성.
          // 차감이 섞인 leg에서 행 부재는 회계 불변식 위반 — update가 throw (조용한 음수 행 생성 금지).
          const wallet = leg.creditOnly
            ? await tx.wallet.upsert({
                where: { userId_assetSymbol_marketType: key },
                create: { ...key, balance: leg.balanceDec, locked: leg.lockedDec },
                update: {
                  locked: { increment: leg.lockedDec },
                  balance: { increment: leg.balanceDec },
                },
              })
            : await tx.wallet.update({
                where: { userId_assetSymbol_marketType: key },
                data: {
                  locked: { increment: leg.lockedDec },
                  balance: { increment: leg.balanceDec },
                },
              });
          updatedWallets.push(wallet);
        }
      }

      for (const ol of orderLegs) {
        await tx.order.update({
          where: { id: ol.orderId },
          data: {
            executedQty: { increment: ol.executedDec },
            cumulativeQuoteQty: { increment: ol.cumulativeDec },
          },
        });
      }

      // S0 원장 섀도: 적용된 이벤트의 leg를 저널 (fast-path와 동일 sourceKey 규칙 — 이중 기록 시 @unique가 차단).
      const inputs: JournalInput[] = [];
      pushSettlementJournalInputs(inputs, event, legs);
      journalRows.push(...(await this.journal.writeManyInTx(tx, inputs)));
    });

    this.applyJournalRowsLocally(journalRows);
    return useTruth ? [...this.ledgerSnapshots(journalRows).values()] : updatedWallets;
  }

  /** 커밋된 저널 rows를 원장에 즉시 반영 (멱등 — tailer 재수신은 sourceKey no-op). 소유 마켓만. */
  private applyJournalRowsLocally(rows: BalanceJournal[]): void {
    for (const row of rows) {
      if (this.ledger.owns(row.marketType)) this.ledger.applyJournal(toEntry(row));
    }
  }

  /**
   * S2 스냅샷: 저널 rows의 distinct (userId,asset,market) 키를 원장(진실)에서 읽어 Wallet 형태로
   * 합성 (emit용). 프로젝터가 뒤따라 Wallet 행을 갱신하지만 emit은 진실을 즉시 반영.
   */
  private ledgerSnapshots(rows: BalanceJournal[]): Map<string, Wallet> {
    const out = new Map<string, Wallet>();
    for (const row of rows) {
      const parts = { userId: row.userId, assetSymbol: row.assetSymbol, marketType: row.marketType };
      const k = walletKey(parts);
      if (out.has(k) || !this.ledger.owns(row.marketType)) continue;
      const { balance, locked } = this.ledger.getDecimal(parts);
      out.set(k, {
        userId: row.userId,
        assetSymbol: row.assetSymbol,
        marketType: row.marketType,
        balance,
        locked,
        updatedAt: new Date(),
      } as unknown as Wallet);
    }
    return out;
  }
}

// ---------- fast-path 배치 합산 (순수 함수) ----------

/** 배치 진입점(parseWalletLegs)에서 델타 문자열을 Decimal로 1회 파싱한 leg. creditOnly도 1회 산출. */
interface ParsedWalletLeg extends WalletLeg {
  lockedDec: Decimal;
  balanceDec: Decimal;
  creditOnly: boolean; // lockedDec>=0 && balanceDec>=0 → 순수 credit(행 부재 허용)
}

interface ParsedOrderLeg extends OrderLeg {
  executedDec: Decimal;
  cumulativeDec: Decimal;
}

interface ParsedEvent {
  id: string;
  walletLegs: ParsedWalletLeg[];
  orderLegs: ParsedOrderLeg[];
}

interface WalletKey {
  userId: string;
  assetSymbol: string;
  marketType: MarketType;
}

interface WalletDelta extends WalletKey {
  locked: Decimal;
  balance: Decimal;
  hasDebit: boolean; // 기여 leg 중 하나라도 순수 credit이 아니면 true → 행 존재 필요(update)
}

interface OrderDelta {
  orderId: string;
  executedQty: Decimal;
  cumulativeQuoteQty: Decimal;
}

interface BatchPlan {
  appliedEventIds: string[];
  excludedEventIds: string[];
  walletDeltas: WalletDelta[];
  orderDeltas: OrderDelta[];
}

/** (userId,asset,market) 합성 키 문자열. leg/row 모두 동일 필드 순서로 생성. */
export function walletKey(k: WalletKey): string {
  return `${k.userId} ${k.assetSymbol} ${k.marketType}`;
}

/** 저널 sourceKey: 이벤트 sourceKey 기반 leg별 유일 (@unique 충돌 방지 + fast-path/per-event 재적용 멱등). */
export function settlementLegKey(eventSourceKey: string, legIndex: number): string {
  return `${eventSourceKey}#${legIndex}`;
}

/** 정산 이벤트의 wallet leg들을 BalanceJournal 입력으로 변환해 out에 append (leg 델타 = wallet 변이 델타). */
export function pushSettlementJournalInputs(
  out: JournalInput[],
  event: SettlementEvent,
  legs: ParsedWalletLeg[],
): void {
  const kind =
    event.kind === SettlementKind.TRADE
      ? BalanceJournalKind.SPOT_TRADE
      : BalanceJournalKind.SPOT_REFUND;
  legs.forEach((leg, i) => {
    out.push({
      userId: leg.userId,
      assetSymbol: leg.assetSymbol,
      marketType: leg.marketType,
      kind,
      deltaBalance: leg.balanceDec,
      deltaLocked: leg.lockedDec,
      sourceKey: settlementLegKey(event.sourceKey, i),
      meta: { eventId: event.id, settlementKind: event.kind, legIndex: i },
    });
  });
}

/** 차감성 leg가 겨냥하는 서로 다른 (userId,asset,market) 키 목록(존재 확인 대상). */
export function debitKeysOf(events: ParsedEvent[]): WalletKey[] {
  const seen = new Map<string, WalletKey>();
  for (const e of events) {
    for (const leg of e.walletLegs) {
      if (leg.creditOnly) continue;
      const k: WalletKey = {
        userId: leg.userId,
        assetSymbol: leg.assetSymbol,
        marketType: leg.marketType,
      };
      const s = walletKey(k);
      if (!seen.has(s)) seen.set(s, k);
    }
  }
  return [...seen.values()];
}

/**
 * 배치 적용 계획 산출(순수). absentDebitKeys(차감 대상인데 행 부재)에 차감 leg를 걸친 이벤트는
 * 제외(PENDING 유지→per-event가 격리). 나머지를 (userId,asset,market) / orderId 별로 Decimal 합산.
 * increment 합 = 합 increment 이라 per-event 순차 적용과 결과 동일.
 */
export function planBatch(events: ParsedEvent[], absentDebitKeys: Set<string>): BatchPlan {
  const excludedEventIds: string[] = [];
  const included: ParsedEvent[] = [];
  for (const e of events) {
    const hitsAbsent = e.walletLegs.some(
      (leg) => !leg.creditOnly && absentDebitKeys.has(walletKey(leg)),
    );
    if (hitsAbsent) excludedEventIds.push(e.id);
    else included.push(e);
  }

  const wallets = new Map<string, WalletDelta>();
  const orders = new Map<string, OrderDelta>();
  for (const e of included) {
    for (const leg of e.walletLegs) {
      const s = walletKey(leg);
      let d = wallets.get(s);
      if (!d) {
        d = {
          userId: leg.userId,
          assetSymbol: leg.assetSymbol,
          marketType: leg.marketType,
          locked: new Decimal(0),
          balance: new Decimal(0),
          hasDebit: false,
        };
        wallets.set(s, d);
      }
      d.locked = d.locked.add(leg.lockedDec);
      d.balance = d.balance.add(leg.balanceDec);
      if (!leg.creditOnly) d.hasDebit = true;
    }
    for (const leg of e.orderLegs) {
      let o = orders.get(leg.orderId);
      if (!o) {
        o = { orderId: leg.orderId, executedQty: new Decimal(0), cumulativeQuoteQty: new Decimal(0) };
        orders.set(leg.orderId, o);
      }
      o.executedQty = o.executedQty.add(leg.executedDec);
      o.cumulativeQuoteQty = o.cumulativeQuoteQty.add(leg.cumulativeDec);
    }
  }

  return {
    appliedEventIds: included.map((e) => e.id),
    excludedEventIds,
    walletDeltas: [...wallets.values()],
    orderDeltas: [...orders.values()],
  };
}

/**
 * legs 형태 검증 후 델타를 Decimal로 1회 파싱 (재파싱 제거의 단일 진입점).
 * creditOnly = lockedDec>=0 && balanceDec>=0 (순수 credit → 행 부재 허용). 모르는 형태면 throw
 * (PENDING 유지, 조용한 유실 방지). Decimal은 불변이라 하류에서 인스턴스 공유 안전.
 */
function parseWalletLegs(event: SettlementEvent): ParsedWalletLeg[] {
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
    const wl = leg as unknown as WalletLeg;
    const lockedDec = new Decimal(wl.lockedDelta);
    const balanceDec = new Decimal(wl.balanceDelta);
    return {
      ...wl,
      lockedDec,
      balanceDec,
      creditOnly: lockedDec.gte(0) && balanceDec.gte(0),
    };
  });
}

function parseOrderLegs(event: SettlementEvent): ParsedOrderLeg[] {
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
    const ol = leg as unknown as OrderLeg;
    return {
      ...ol,
      executedDec: new Decimal(ol.executedQtyDelta),
      cumulativeDec: new Decimal(ol.cumulativeQuoteQtyDelta),
    };
  });
}
