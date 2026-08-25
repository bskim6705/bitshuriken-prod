import { Injectable, Logger } from '@nestjs/common';
import { BalanceJournal } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { LedgerAvailability } from './ledger-availability';
import { LedgerService } from './ledger.service';
import { JournalInput, LedgerEntry } from './ledger.types';
import { toScaledBigint } from './scaled';

const DEFAULT_BATCH = 2000;
const DEFAULT_GRACE_TICKS = 2;
// tick 1회가 tail을 소화하는 fetch 반복 상한 — 폭주 저널에서도 tick이 유한 시간에 반환하게.
const MAX_FETCH_ROUNDS = 10;

export interface TailResult {
  fetched: number;
  applied: number;
  duplicates: number;
  skippedGaps: number[];
  watermark: number;
}

/**
 * 저널 테일러. `seq > watermark ORDER BY seq`를 **언스코프**(전 마켓)로 폴링한다 — seq는 전역
 * 시퀀스라, 소유 마켓으로 필터하면 타 마켓 seq가 전부 결번으로 보여 워터마크가 틱당 grace-스킵
 * 1개씩만 기어가고 매 틱 O(전체 백로그) 재스캔이 된다 (라이브 실측: futures watermark 9 고정).
 * fetch된 행 중 소유 마켓만 원장에 적용하고, 타 마켓 행은 "seq 존재 확인"으로만 소비해 워터마크를
 * 전진시킨다. 비용: 두 앱이 전체 저널을 읽는다 — 수용 (스냅샷 도입은 후속).
 *
 * 멱등/갭 시맨틱:
 *  - LedgerService.applyJournal이 sourceKey seen-set으로 이중 적용을 막는다 (reserve로 선반영된
 *    place-lock, 크래시 재수신 모두 안전).
 *  - autoincrement seq는 커밋 순서와 다를 수 있고(동시 tx), **롤백된 tx는 seq를 영구 소각**한다.
 *    따라서 연속성을 요구하지 않는다: 워터마크는 fetch에 존재하는 seq까지 전진하고, **진짜 결번**
 *    (어느 마켓에도 없는 seq = 미커밋/롤백)만 grace(기본 2 tick) 경과 후 스킵한다. 증분은 가환이라
 *    갭 너머 엔트리를 먼저 적용해도 안전하고(seen-set이 재적용 방지), 스킵된 seq는 (a) 롤백돼
 *    적용할 게 없거나 (b) grace 내에 커밋돼 이미 적용된 경우뿐이다.
 */
@Injectable()
export class JournalTailer {
  private readonly logger = new Logger(JournalTailer.name);
  private watermark = 0;
  // 미해결 갭 seq → 관측된 tick 수 (grace 카운터).
  private readonly gapSince = new Map<number, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly availability: LedgerAvailability,
    private readonly graceTicks: number = DEFAULT_GRACE_TICKS,
    private readonly batchSize: number = DEFAULT_BATCH,
  ) {}

  currentWatermark(): number {
    return this.watermark;
  }

  /**
   * 부트 리플레이 (섀도 단계는 전량 리플레이로 충분). 원장 초기화 후 저널 전체를 언스코프로 seq 순
   * 스캔해 소유 마켓 행만 멱등 적용하고, 워터마크는 **전역 최대 seq**로 세운다 (소유 마켓 max로
   * 세우면 부트 직후 tick이 타 마켓 백로그를 갭으로 오인). 멱등 — 2회 호출해도 동일 상태.
   * 강등 시 no-op (원장 reset도 하지 않음).
   */
  async replayAll(): Promise<{ applied: number; watermark: number }> {
    if (!this.availability.enabled) return { applied: 0, watermark: this.watermark };
    this.ledger.markReplayDone(false); // 리플레이 창 — 음수 경보 debug 강등
    this.ledger.reset();
    this.watermark = 0;
    this.gapSince.clear();

    let applied = 0;
    for (;;) {
      const rows = await this.prisma.balanceJournal.findMany({
        where: { seq: { gt: this.watermark } },
        orderBy: { seq: 'asc' },
        take: this.batchSize,
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        if (this.ledger.owns(row.marketType) && this.ledger.applyJournal(toEntry(row))) {
          applied++;
        }
        this.watermark = row.seq;
      }
      if (rows.length < this.batchSize) break;
    }
    // 리플레이 완료 = DB max까지 소화 — steady-state 진입 (이후는 tick이 tail 소진 여부로 갱신).
    this.ledger.markReplayDone(true);
    this.ledger.markTailDrained(true);
    this.logger.log(`ledger replay complete: applied=${applied} watermark=${this.watermark}`);
    return { applied, watermark: this.watermark };
  }

  /**
   * 증분 폴링 1회. tail을 소화할 때까지 배치 fetch를 반복(상한 MAX_FETCH_ROUNDS)하며, 소유 마켓
   * 행은 가환 적용·타 마켓 행은 존재 확인만으로 워터마크를 전진시킨다. 진짜 결번은 grace 미만이면
   * 워터마크를 그 직전에 두고 반복을 중단(다음 tick 재관측 — grace는 tick 단위), 경과면 스킵.
   * 갭 너머 이미 적용된 행의 재질의는 seen-set no-op. 강등 시 no-op.
   *
   * 2단 fetch (자기-행 재fetch 제거): 1차는 {seq,marketType,sourceKey}만 fetch(파싱 극경량) —
   * 워터마크 전진·갭 판정에 필요한 전부. delta(Decimal/JSON) full-parse는 소유 마켓이면서 아직
   * 미적용(seen-set 부재)인 seq만 2차로 fetch해 적용한다. 정상 상태에서 자기 프로세스가 방금 쓰고
   * reserve/applyJournal로 이미 반영한 행은 seen-set에 있어 2차 대상이 아니고, 2차는 외부 유입
   * (portal 콜드 플로우 등)만 = 거의 0. 세금이 O(전체 tail) → O(외부 유입)으로 축소된다.
   */
  async tick(): Promise<TailResult> {
    if (!this.availability.enabled) {
      return { fetched: 0, applied: 0, duplicates: 0, skippedGaps: [], watermark: this.watermark };
    }

    let fetched = 0;
    let applied = 0;
    let duplicates = 0;
    let lastRoundLen = 0;
    const skippedGaps: number[] = [];

    for (let round = 0; round < MAX_FETCH_ROUNDS; round++) {
      // 1차: 경량 헤더만 (seq/marketType/sourceKey). Decimal delta는 파싱하지 않는다.
      const heads = await this.prisma.balanceJournal.findMany({
        where: { seq: { gt: this.watermark } },
        orderBy: { seq: 'asc' },
        take: this.batchSize,
        select: { seq: true, marketType: true, sourceKey: true },
      });
      fetched += heads.length;
      lastRoundLen = heads.length;

      const present = new Set<number>();
      const needFull: number[] = []; // 소유 마켓 & 미적용 seq만 — 2차 full-fetch 대상
      for (const h of heads) {
        present.add(h.seq);
        if (!this.ledger.owns(h.marketType)) continue; // 타 마켓 — 존재 확인만
        if (this.ledger.hasApplied(h.sourceKey)) {
          duplicates++; // 이미 반영(자기-행/재수신) — full-fetch·재적용 불필요
          continue;
        }
        needFull.push(h.seq);
      }

      // 2차: 아직 적용 안 된 소유 마켓 행만 full-fetch해 가환 적용. 정상 상태에선 외부 유입만.
      if (needFull.length > 0) {
        const rows = await this.prisma.balanceJournal.findMany({
          where: { seq: { in: needFull } },
        });
        for (const row of rows) {
          if (this.ledger.applyJournal(toEntry(row))) applied++;
          else duplicates++; // 1차·2차 사이 다른 경로가 선반영(seen-set no-op)
        }
      }

      const maxSeq = heads.length > 0 ? heads[heads.length - 1].seq : this.watermark;
      let wm = this.watermark;
      while (wm < maxSeq) {
        const next = wm + 1;
        if (present.has(next)) {
          this.gapSince.delete(next);
          wm = next;
          continue;
        }
        // next는 어느 마켓에도 없는 진짜 결번 — 미커밋 or 롤백 소각.
        const since = (this.gapSince.get(next) ?? 0) + 1;
        if (since >= this.graceTicks) {
          this.gapSince.delete(next);
          skippedGaps.push(next);
          wm = next;
          continue;
        }
        this.gapSince.set(next, since);
        break; // 이 갭이 채워지길 기다린다 (워터마크 정지)
      }
      const heldByGap = wm < maxSeq;
      this.watermark = wm;

      // 갭 대기 중이면 중단(같은 tick 재관측은 grace를 이중 카운트), tail 소진(부분 배치)이어도 중단.
      if (heldByGap || heads.length < this.batchSize) break;
    }

    // tail 소진(마지막 fetch < batch) = 따라잡음 → 음수 경보 error 승격 허용. 캐치업 중이면 debug.
    this.ledger.markTailDrained(lastRoundLen < this.batchSize);

    if (skippedGaps.length > 0) {
      this.logger.warn(`ledger tailer skipped dead seq gaps after grace: ${skippedGaps.join(',')}`);
    }
    return { fetched, applied, duplicates, skippedGaps, watermark: this.watermark };
  }
}

/** DB row(Decimal delta) → LedgerEntry(bigint delta). */
export function toEntry(row: BalanceJournal): LedgerEntry {
  return {
    seq: row.seq,
    sourceKey: row.sourceKey,
    userId: row.userId,
    assetSymbol: row.assetSymbol,
    marketType: row.marketType,
    deltaBalance: toScaledBigint(row.deltaBalance),
    deltaLocked: toScaledBigint(row.deltaLocked),
  };
}

/**
 * INSERT 입력 → LedgerEntry — createMany 경로의 커밋 직후 로컬 반영용 (반환 row 없음).
 * seq=0: applyJournal은 sourceKey seen-set만 쓰고 seq는 미사용. tailer 재수신은 no-op.
 */
export function inputToEntry(input: JournalInput): LedgerEntry {
  return {
    seq: 0,
    sourceKey: input.sourceKey,
    userId: input.userId,
    assetSymbol: input.assetSymbol,
    marketType: input.marketType,
    deltaBalance: toScaledBigint(input.deltaBalance),
    deltaLocked: toScaledBigint(input.deltaLocked),
  };
}
