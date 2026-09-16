import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { MarketType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { LedgerEntry, ScaledBalance, WalletKeyParts, ledgerKey } from './ledger.types';
import { formatScaled, toScaledBigint } from './scaled';

/** LedgerModule.forRoot(...)가 채우는 소유 마켓 토큰. 비어 있으면 전 마켓 소유(테스트/단일마켓). */
export const LEDGER_OWNED_MARKETS = 'LEDGER_OWNED_MARKETS';

/**
 * ADR-069 인메모리 잔고 원장 (앱당 싱글턴). Wallet 행을 대체하는 잔고 진실.
 *
 * 소유 토폴로지(§6): be-spot=SPOT 지갑, be-futures=FUTURES 지갑. ownedMarkets가 지정되면 그 외
 * 마켓의 변이는 throw(위상 위반 = 버그). portal은 이 서비스를 인스턴스화하지 않고 JournalWriter로
 * append만 하며, 적용은 소유 앱의 JournalTailer가 수행한다.
 *
 * 잔고는 ×10^8 정수 bigint (엔진 규율: 정수 산술·floor·부동소수점 금지). 모든 map 변이는 mutate()
 * 한 곳을 지난다. reserve()는 동기 체크+홀드(await 없음 → Node 단일 스레드가 원자성 보장).
 * applyJournal()은 sourceKey seen-set으로 멱등 — reserve(커밋 직후 로컬 반영)와 tailer(저널 재수신)가
 * 같은 엔트리를 이중 적용하지 않는다.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);
  private readonly balances = new Map<string, ScaledBalance>();
  // 이미 원장에 반영된 sourceKey — reserve()와 applyJournal()이 함께 채운다(이중 적용 방지).
  private readonly applied = new Set<string>();
  // S2 프로젝터 워크리스트: 변이된 키 (절대값 재프로젝션 대상). 프로젝터가 drainDirty로 비운다.
  private readonly dirty = new Set<string>();
  // 음수 경보 게이트 — 리플레이/캐치업 창의 음수 딥은 torn 관측(적용 경로 교차, 최종 수렴)이라
  // steady-state에서만 error로 승격한다. tailer가 두 플래그를 갱신.
  private replayDone = false;
  private tailDrained = false;
  private readonly ownedMarkets: ReadonlySet<MarketType>;

  constructor(@Optional() @Inject(LEDGER_OWNED_MARKETS) ownedMarkets?: MarketType[]) {
    this.ownedMarkets = new Set(ownedMarkets ?? []);
  }

  /** 소유 마켓인가 (빈 소유집합 = 전 마켓 소유). */
  owns(marketType: MarketType): boolean {
    return this.ownedMarkets.size === 0 || this.ownedMarkets.has(marketType);
  }

  /** 소유 마켓 목록 (빈 배열 = 전 마켓). tailer/replay/drift의 조회 스코프. */
  ownedMarketList(): MarketType[] {
    return [...this.ownedMarkets];
  }

  // ---------- 음수 경보 게이트 (tailer가 갱신) ----------

  /** 부트 리플레이 완료 여부 — replayAll이 시작 시 false, 완료 시 true로 세팅. */
  markReplayDone(done: boolean): void {
    this.replayDone = done;
  }

  /** 최근 tick이 tail을 소진(fetched < batch)했는지 — 캐치업 중이면 false. */
  markTailDrained(drained: boolean): void {
    this.tailDrained = drained;
  }

  /** steady-state = 리플레이 완료 + tail 소진. 이때만 음수 경보가 error로 승격. */
  get steadyState(): boolean {
    return this.replayDone && this.tailDrained;
  }

  // ---------- 조회 ----------

  /** scaled 잔고 사본 (부재 시 0/0). 외부 변이 방지를 위해 복제 반환. */
  getScaled(parts: WalletKeyParts): ScaledBalance {
    const cur = this.balances.get(ledgerKey(parts));
    return cur ? { balance: cur.balance, locked: cur.locked } : { balance: 0n, locked: 0n };
  }

  /** Decimal 잔고 (BE 경계 소비자용). */
  getDecimal(parts: WalletKeyParts): { balance: Decimal; locked: Decimal } {
    const s = this.getScaled(parts);
    return {
      balance: new Decimal(s.balance.toString()).div(1e8),
      locked: new Decimal(s.locked.toString()).div(1e8),
    };
  }

  /** 전 키 스냅샷 (DriftChecker 대사 재료). 복제본. */
  snapshot(): Map<string, ScaledBalance> {
    const out = new Map<string, ScaledBalance>();
    for (const [k, v] of this.balances) out.set(k, { balance: v.balance, locked: v.locked });
    return out;
  }

  size(): number {
    return this.balances.size;
  }

  // ---------- 변이 ----------

  /**
   * 동기 체크+홀드 (place 경로 동결). free(=balance) ≥ amount면 balance→locked 이동 후 sourceKey를
   * applied에 기록하고 true, 부족하면 무변이 false. **await 없음** — check와 hold 사이에 yield가
   * 없어야 동시 접수의 초과 인출이 불가능하다 (S2 place 경로 API).
   */
  reserve(parts: WalletKeyParts, amount: Decimal.Value, sourceKey: string): boolean {
    this.assertOwned(parts.marketType);
    const amt = toScaledBigint(amount);
    if (amt < 0n) throw new Error(`ledger.reserve: negative amount ${amt}`);
    const key = ledgerKey(parts);
    const cur = this.slot(parts, key);
    if (cur.balance < amt) return false;
    cur.balance -= amt;
    cur.locked += amt;
    this.applied.add(sourceKey);
    this.afterMutate(key, cur);
    return true;
  }

  /**
   * 순수 balance 차감(체크 포함) — 마진 추가처럼 balance가 wallet 밖(포지션 isolatedMargin)으로
   * 이동하는 wallet leg용. reserve와 달리 locked를 늘리지 않는다. free ≥ amount면 차감 후 true,
   * 부족하면 무변이 false. **await 없음** — reserve와 동일 원자성.
   */
  debit(parts: WalletKeyParts, amount: Decimal.Value, sourceKey: string): boolean {
    this.assertOwned(parts.marketType);
    const amt = toScaledBigint(amount);
    if (amt < 0n) throw new Error(`ledger.debit: negative amount ${amt}`);
    const key = ledgerKey(parts);
    const cur = this.slot(parts, key);
    if (cur.balance < amt) return false;
    cur.balance -= amt;
    this.applied.add(sourceKey);
    this.afterMutate(key, cur);
    return true;
  }

  /** debit 보상(저널 커밋 실패 시). */
  rollbackDebit(parts: WalletKeyParts, amount: Decimal.Value, sourceKey: string): void {
    this.assertOwned(parts.marketType);
    const amt = toScaledBigint(amount);
    const key = ledgerKey(parts);
    const cur = this.slot(parts, key);
    cur.balance += amt;
    this.applied.delete(sourceKey);
    this.afterMutate(key, cur);
  }

  /**
   * reserve 보상: 저널 커밋 실패 시 인메모리 홀드를 되돌린다 (locked→balance) + sourceKey 회수.
   * reserve와 대칭 — 커밋 실패 경로에서만 호출.
   */
  rollbackReserve(parts: WalletKeyParts, amount: Decimal.Value, sourceKey: string): void {
    this.assertOwned(parts.marketType);
    const amt = toScaledBigint(amount);
    const key = ledgerKey(parts);
    const cur = this.slot(parts, key);
    cur.balance += amt;
    cur.locked -= amt;
    this.applied.delete(sourceKey);
    this.afterMutate(key, cur);
  }

  /**
   * 순수 증분 적용 (가환 — 순서 무관). 멱등 아님(호출 시마다 증분). 저널 delta의 저수준 primitive이며
   * 커밋 확정 금액의 순수 이동에만 쓴다.
   */
  apply(parts: WalletKeyParts, deltaBalance: bigint, deltaLocked: bigint): void {
    this.assertOwned(parts.marketType);
    const key = ledgerKey(parts);
    const cur = this.slot(parts, key);
    cur.balance += deltaBalance;
    cur.locked += deltaLocked;
    this.afterMutate(key, cur);
  }

  /**
   * 저널 엔트리 멱등 적용 (JournalTailer·boot replay·커밋 직후 로컬 반영 공용).
   * 이미 본 sourceKey면 no-op(false) — reserve로 선반영된 place-lock 엔트리나 크래시 재수신을
   * 이중 적용하지 않는다. 새로 적용하면 true.
   */
  applyJournal(entry: LedgerEntry): boolean {
    if (this.applied.has(entry.sourceKey)) return false;
    this.apply(
      { userId: entry.userId, assetSymbol: entry.assetSymbol, marketType: entry.marketType },
      entry.deltaBalance,
      entry.deltaLocked,
    );
    this.applied.add(entry.sourceKey);
    return true;
  }

  // ---------- seen-set 관리 ----------

  hasApplied(sourceKey: string): boolean {
    return this.applied.has(sourceKey);
  }

  /** boot replay 시작 시 전 상태 초기화 — replay가 저널로부터 결정적으로 재구성(멱등). */
  reset(): void {
    this.balances.clear();
    this.applied.clear();
    this.dirty.clear();
  }

  // ---------- S2 프로젝터 워크리스트 ----------

  /** 변이 이후 프로젝터에 다시 반영될 dirty 키를 비워 반환. 절대값 프로젝션이라 순서·중복 무관. */
  drainDirty(): string[] {
    const out = [...this.dirty];
    this.dirty.clear();
    return out;
  }

  /** 현재 보유 전 키 (크래시 후 프로젝터 최초 1회 전량 재프로젝션 — §6-5 수렴). */
  allKeys(): string[] {
    return [...this.balances.keys()];
  }

  // ---------- 내부 ----------

  /**
   * 변이 공통 후처리: dirty 마킹 + 음수 경보(클램프 금지, 기록만 — portal 콜드 레이스 관측 수단).
   * 리플레이/캐치업 창의 음수 딥은 적용 경로 교차의 torn 관측이라 필연 발화·최종 수렴(포렌식 실측:
   * seq 재생 시 음수 딥 0) — steady-state에서만 error, 그 외 debug.
   */
  private afterMutate(key: string, cur: ScaledBalance): void {
    this.dirty.add(key);
    if (cur.balance < 0n || cur.locked < 0n) {
      const msg = `[ledger-negative] key=${key} balance=${formatScaled(cur.balance)} locked=${formatScaled(cur.locked)}`;
      if (this.steadyState) this.logger.error(msg);
      else this.logger.debug(msg);
    }
  }

  private slot(parts: WalletKeyParts, key = ledgerKey(parts)): ScaledBalance {
    let cur = this.balances.get(key);
    if (!cur) {
      cur = { balance: 0n, locked: 0n };
      this.balances.set(key, cur);
    }
    return cur;
  }

  private assertOwned(marketType: MarketType): void {
    if (!this.owns(marketType)) {
      throw new Error(
        `ledger: market ${marketType} not owned by this instance (owned: ${
          this.ownedMarketList().join(',') || 'ALL'
        })`,
      );
    }
  }
}
