import { MarketType } from '@prisma/client';
import { LedgerService } from './ledger.service';
import { LedgerEntry, WalletKeyParts } from './ledger.types';

const SPOT = MarketType.SPOT;
const FUTURES = MarketType.FUTURES;
const key = (userId: string, asset = 'USDT', market: MarketType = SPOT): WalletKeyParts => ({
  userId,
  assetSymbol: asset,
  marketType: market,
});

function entry(over: Partial<LedgerEntry> & { sourceKey: string }): LedgerEntry {
  return {
    seq: 0,
    userId: 'u1',
    assetSymbol: 'USDT',
    marketType: SPOT,
    deltaBalance: 0n,
    deltaLocked: 0n,
    ...over,
  };
}

describe('LedgerService', () => {
  describe('reserve (동기 체크-홀드)', () => {
    it('is synchronous (no await between check and hold)', () => {
      const led = new LedgerService([SPOT]);
      led.apply(key('u1'), 100_00000000n, 0n); // 100 USDT
      const result = led.reserve(key('u1'), '40', 'lock:o1');
      // 반환이 boolean(비-thenable)이어야 check-hold 사이 yield 부재 = 원자성
      expect(typeof result).toBe('boolean');
      expect((result as unknown as { then?: unknown }).then).toBeUndefined();
    });

    it('holds balance→locked and prevents overdraw across sequential reserves', () => {
      const led = new LedgerService([SPOT]);
      led.apply(key('u1'), 100_00000000n, 0n);

      expect(led.reserve(key('u1'), '60', 'lock:o1')).toBe(true);
      expect(led.getScaled(key('u1'))).toEqual({ balance: 40_00000000n, locked: 60_00000000n });

      // 남은 free=40 < 60 → 거절, 상태 불변 (초과 인출 불가)
      expect(led.reserve(key('u1'), '60', 'lock:o2')).toBe(false);
      expect(led.getScaled(key('u1'))).toEqual({ balance: 40_00000000n, locked: 60_00000000n });
    });

    it('rejects negative reserve and unowned market', () => {
      const led = new LedgerService([SPOT]);
      led.apply(key('u1'), 100_00000000n, 0n);
      expect(() => led.reserve(key('u1'), '-5', 'x')).toThrow(/negative/);
      expect(() => led.reserve(key('u1', 'USDT', FUTURES), '5', 'x')).toThrow(/not owned/);
    });

    it('rollbackReserve compensates a held reserve (저널 커밋 실패 보상)', () => {
      const led = new LedgerService([SPOT]);
      led.apply(key('u1'), 100_00000000n, 0n);
      led.reserve(key('u1'), '60', 'lock:o1');
      led.rollbackReserve(key('u1'), '60', 'lock:o1');
      expect(led.getScaled(key('u1'))).toEqual({ balance: 100_00000000n, locked: 0n });
      // sourceKey 회수됨 → tailer가 나중에 같은 엔트리를 적용 가능
      expect(led.hasApplied('lock:o1')).toBe(false);
    });
  });

  describe('apply commutativity (가환 — 순서 무관)', () => {
    const deltas: Array<[bigint, bigint]> = [
      [50_00000000n, 0n], // credit
      [-30_00000000n, 30_00000000n], // freeze
      [10_00000000n, -5_00000000n], // partial release
      [-7_00000000n, 0n], // debit
    ];

    const run = (order: number[]) => {
      const led = new LedgerService([SPOT]);
      led.apply(key('u1'), 100_00000000n, 0n);
      for (const i of order) led.apply(key('u1'), deltas[i][0], deltas[i][1]);
      return led.getScaled(key('u1'));
    };

    it('yields identical state regardless of application order', () => {
      const a = run([0, 1, 2, 3]);
      const b = run([3, 2, 1, 0]);
      const c = run([2, 0, 3, 1]);
      expect(b).toEqual(a);
      expect(c).toEqual(a);
      expect(a).toEqual({ balance: 123_00000000n, locked: 25_00000000n });
    });
  });

  describe('applyJournal idempotency (sourceKey 중복 no-op)', () => {
    it('applies once, ignores duplicate sourceKey', () => {
      const led = new LedgerService([SPOT]);
      const e = entry({ sourceKey: 'trade:1', deltaBalance: 10_00000000n });
      expect(led.applyJournal(e)).toBe(true);
      expect(led.applyJournal(e)).toBe(false); // 중복 → no-op
      expect(led.getScaled(key('u1'))).toEqual({ balance: 10_00000000n, locked: 0n });
    });

    it('does not double-apply a reserve that later arrives via journal', () => {
      const led = new LedgerService([SPOT]);
      led.apply(key('u1'), 100_00000000n, 0n);
      led.reserve(key('u1'), '40', 'lock:o1'); // 로컬 선반영 (sourceKey 기록됨)
      // tailer가 같은 place-lock 저널 엔트리를 재수신 → 이중 적용 안 됨
      const journalOfLock = entry({
        seq: 5,
        sourceKey: 'lock:o1',
        deltaBalance: -40_00000000n,
        deltaLocked: 40_00000000n,
      });
      expect(led.applyJournal(journalOfLock)).toBe(false);
      expect(led.getScaled(key('u1'))).toEqual({ balance: 60_00000000n, locked: 40_00000000n });
    });
  });

  describe('debit (순수 balance 차감, 마진 추가 leg)', () => {
    it('free ≥ amount면 balance만 차감(locked 불변), 부족하면 무변이 false', () => {
      const led = new LedgerService([SPOT]);
      led.apply(key('u1'), 100_00000000n, 0n);
      expect(led.debit(key('u1'), '30', 'marginadd:1')).toBe(true);
      expect(led.getScaled(key('u1'))).toEqual({ balance: 70_00000000n, locked: 0n });
      expect(led.debit(key('u1'), '80', 'marginadd:2')).toBe(false); // 70 < 80
      expect(led.getScaled(key('u1'))).toEqual({ balance: 70_00000000n, locked: 0n });
    });

    it('rollbackDebit가 차감을 되돌리고 sourceKey를 회수', () => {
      const led = new LedgerService([SPOT]);
      led.apply(key('u1'), 100_00000000n, 0n);
      led.debit(key('u1'), '30', 'marginadd:1');
      led.rollbackDebit(key('u1'), '30', 'marginadd:1');
      expect(led.getScaled(key('u1'))).toEqual({ balance: 100_00000000n, locked: 0n });
      expect(led.hasApplied('marginadd:1')).toBe(false);
    });
  });

  describe('dirty 워크리스트 (프로젝터 재료)', () => {
    it('변이 키를 dirty로 모으고 drainDirty가 비워 반환(절대값 프로젝션이라 순서·중복 무관)', () => {
      const led = new LedgerService([SPOT]);
      led.apply(key('u1'), 10_00000000n, 0n);
      led.reserve(key('u1'), '4', 'lock:o1');
      led.apply(key('u2'), 5_00000000n, 0n);
      const drained = led.drainDirty().sort();
      expect(drained).toEqual(['u1 USDT SPOT', 'u2 USDT SPOT']);
      expect(led.drainDirty()).toEqual([]); // 비워짐
      // 이후 변이만 다시 dirty
      led.apply(key('u2'), 1_00000000n, 0n);
      expect(led.drainDirty()).toEqual(['u2 USDT SPOT']);
    });

    it('reset이 dirty도 비운다', () => {
      const led = new LedgerService([SPOT]);
      led.apply(key('u1'), 1n, 0n);
      led.reset();
      expect(led.drainDirty()).toEqual([]);
      expect(led.allKeys()).toEqual([]);
    });
  });

  describe('음수 잔고 경보 (클램프 금지, steady-state 게이팅)', () => {
    const logSpies = (led: LedgerService) => {
      const logger = (led as unknown as { logger: { error: jest.Mock; debug: jest.Mock } }).logger;
      return {
        error: jest.spyOn(logger, 'error').mockImplementation(),
        debug: jest.spyOn(logger, 'debug').mockImplementation(),
      };
    };

    it('리플레이/캐치업 창의 음수는 debug 강등 (torn 관측 소음), 클램프는 여전히 안 함', () => {
      const led = new LedgerService([SPOT]); // 기본 = 리플레이 미완 (부트 창)
      const spy = logSpies(led);
      led.apply(key('u1'), -5_00000000n, 0n); // 0 → -5 (음수 허용)
      expect(led.getScaled(key('u1'))).toEqual({ balance: -5_00000000n, locked: 0n });
      expect(spy.error).not.toHaveBeenCalled();
      expect(spy.debug).toHaveBeenCalledWith(expect.stringContaining('[ledger-negative]'));
    });

    it('steady-state(리플레이 완료 + tail 소진) 음수는 error 승격', () => {
      const led = new LedgerService([SPOT]);
      led.markReplayDone(true);
      led.markTailDrained(true);
      const spy = logSpies(led);
      led.apply(key('u1'), -5_00000000n, 0n);
      expect(spy.error).toHaveBeenCalledWith(expect.stringContaining('[ledger-negative]'));
      expect(spy.debug).not.toHaveBeenCalled();
    });
  });

  describe('ownership topology', () => {
    it('empty ownedMarkets owns all', () => {
      const led = new LedgerService();
      expect(led.owns(SPOT)).toBe(true);
      expect(led.owns(FUTURES)).toBe(true);
    });
    it('scoped instance rejects foreign-market apply', () => {
      const led = new LedgerService([SPOT]);
      expect(led.owns(FUTURES)).toBe(false);
      expect(() => led.apply(key('u1', 'USDT', FUTURES), 1n, 0n)).toThrow(/not owned/);
    });
  });
});
