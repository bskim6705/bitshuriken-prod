import { BalanceJournal, BalanceJournalKind, MarketType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { JournalTailer, toEntry } from './journal-tailer';
import { LedgerAvailability } from './ledger-availability';
import { LedgerService } from './ledger.service';

const SPOT = MarketType.SPOT;
const AVAILABLE = { enabled: true } as LedgerAvailability;

interface Row {
  seq: number;
  sourceKey: string;
  userId: string;
  assetSymbol: string;
  marketType: MarketType;
  deltaBalance: Decimal;
  deltaLocked: Decimal;
}

function row(seq: number, deltaBalance: string, opts: Partial<Row> = {}): Row {
  return {
    seq,
    sourceKey: opts.sourceKey ?? `s:${seq}`,
    userId: opts.userId ?? 'u1',
    assetSymbol: opts.assetSymbol ?? 'USDT',
    marketType: opts.marketType ?? SPOT,
    deltaBalance: new Decimal(deltaBalance),
    deltaLocked: new Decimal(opts.deltaLocked ?? 0),
  };
}

/**
 * seq>gt(1차 헤더) / seq in [...](2차 full-fetch) + marketType.in 필터, seq asc, take를 흉내내는
 * 인메모리 fake. select는 무시하고 항상 full row를 반환(코드가 헤더 필드만 읽으므로 무해).
 */
function fakePrisma(store: Row[]): PrismaService {
  return {
    balanceJournal: {
      findMany: jest.fn(async (args: any) => {
        const gt = args?.where?.seq?.gt;
        const inSeqs: number[] | undefined = args?.where?.seq?.in;
        const inMarkets: MarketType[] | undefined = args?.where?.marketType?.in;
        let rows = store.slice();
        if (gt !== undefined) rows = rows.filter((r) => r.seq > gt);
        if (inSeqs !== undefined) rows = rows.filter((r) => inSeqs.includes(r.seq));
        if (inMarkets) rows = rows.filter((r) => inMarkets.includes(r.marketType));
        rows.sort((a, b) => a.seq - b.seq);
        if (args?.take) rows = rows.slice(0, args.take);
        return rows as unknown as BalanceJournal[];
      }),
    },
  } as unknown as PrismaService;
}

/** findMany 호출을 1차(헤더: seq.gt/take) vs 2차(full-fetch: seq.in)로 분류. */
function fetchCalls(prisma: PrismaService) {
  const calls = (prisma.balanceJournal.findMany as jest.Mock).mock.calls;
  const full = calls.filter((c) => c[0]?.where?.seq?.in !== undefined);
  return {
    headCount: calls.length - full.length,
    fullCalls: full,
    fullSeqs: full.flatMap((c) => c[0].where.seq.in as number[]),
  };
}

const bal = (led: LedgerService, userId = 'u1') =>
  led.getScaled({ userId, assetSymbol: 'USDT', marketType: SPOT }).balance;

describe('JournalTailer', () => {
  describe('replayAll (부트 리플레이 멱등)', () => {
    it('reconstructs ledger from journal; 2 replays == 1 replay', async () => {
      const store = [row(1, '100'), row(2, '-40'), row(3, '10')];
      const led = new LedgerService([SPOT]);
      const tailer = new JournalTailer(fakePrisma(store), led, AVAILABLE);

      const first = await tailer.replayAll();
      const afterOne = bal(led);
      expect(afterOne).toBe(70_00000000n);
      expect(first.watermark).toBe(3);

      await tailer.replayAll(); // 2회차
      expect(bal(led)).toBe(afterOne); // 동일 상태
      expect(tailer.currentWatermark()).toBe(3);
    });

    it('applies only owned-market rows but advances watermark to the global max seq', async () => {
      const store = [row(1, '100'), row(2, '5', { marketType: MarketType.FUTURES })];
      const led = new LedgerService([SPOT]);
      const tailer = new JournalTailer(fakePrisma(store), led, AVAILABLE);
      const res = await tailer.replayAll();
      expect(bal(led)).toBe(100_00000000n); // futures 행 미반영
      expect(res.applied).toBe(1);
      expect(res.watermark).toBe(2); // 전역 max — 부트 직후 tick이 타 마켓 백로그를 갭으로 오인하지 않음
    });
  });

  describe('unscoped tick (타 마켓 seq는 존재 확인만)', () => {
    it('traverses a 1,000-seq foreign-market run in one tick (watermark global, applied 0)', async () => {
      const store: Row[] = [];
      for (let s = 1; s <= 1000; s++) {
        store.push(row(s, '1', { marketType: MarketType.FUTURES, userId: `f${s}` }));
      }
      const led = new LedgerService([SPOT]);
      // batchSize 200 → 한 tick 안에서 5회 반복 fetch로 tail 소화
      const tailer = new JournalTailer(fakePrisma(store), led, AVAILABLE, 2, 200);

      const t = await tailer.tick();
      expect(t.watermark).toBe(1000); // 한 tick에 전 구간 통과 (틱당 1 seq 크롤 금지)
      expect(t.fetched).toBe(1000);
      expect(t.applied).toBe(0); // 소유 마켓 아님 — 원장 무접촉
      expect(t.skippedGaps).toEqual([]); // 존재하는 seq는 갭이 아니다
      expect(led.size()).toBe(0);

      // 다음 tick은 빈 tail — 재스캔 없음 (O(백로그)/틱 재림 방지)
      const t2 = await tailer.tick();
      expect(t2.fetched).toBe(0);
      expect(t2.watermark).toBe(1000);
    });

    it('steady-state 게이트: replayAll 완료·tail 소진 시 세우고, 캐치업(라운드 상한)이면 내린다', async () => {
      const store = [row(1, '10')];
      const led = new LedgerService([SPOT]);
      const tailer = new JournalTailer(fakePrisma(store), led, AVAILABLE);
      expect(led.steadyState).toBe(false); // 부트 전 — 음수 경보 debug 창
      await tailer.replayAll();
      expect(led.steadyState).toBe(true); // 리플레이 완료 = DB max까지 소화

      // 백로그 폭주: batch 5 × 라운드 상한 10 = 50 < 59 잔여 → 한 tick으로 미소진 = 캐치업
      for (let s = 2; s <= 60; s++) store.push(row(s, '1', { sourceKey: `s:${s}`, userId: `u${s}` }));
      const small = new JournalTailer(fakePrisma(store), led, AVAILABLE, 2, 5);
      await small.tick();
      expect(led.steadyState).toBe(false); // 마지막 fetch == batch → 미소진, error 승격 금지
      await small.tick(); // 잔여 소화
      expect(led.steadyState).toBe(true);
    });

    it('applies only owned rows in a mixed unscoped batch', async () => {
      const store = [
        row(1, '10'),
        row(2, '5', { marketType: MarketType.FUTURES, userId: 'fu' }),
        row(3, '5', { marketType: MarketType.FUTURES, userId: 'fu' }),
        row(4, '7'),
      ];
      const led = new LedgerService([SPOT]);
      const tailer = new JournalTailer(fakePrisma(store), led, AVAILABLE);

      const t = await tailer.tick();
      expect(t.applied).toBe(2); // spot 행만
      expect(t.watermark).toBe(4);
      expect(bal(led)).toBe(17_00000000n);
      expect(led.size()).toBe(1); // futures 키는 원장에 생성되지 않음
    });
  });

  describe('2단 fetch (자기-행 재fetch 제거)', () => {
    it('로컬 적용분은 헤더만 소비(full-fetch 0), 외부 유입만 full-fetch·적용', async () => {
      // seq 1~3 = 자기 프로세스가 이미 쓰고 반영(seen-set 존재), seq 4 = 외부 유입(portal 등).
      const store = [row(1, '10'), row(2, '10'), row(3, '10'), row(4, '7', { sourceKey: 'ext:4' })];
      const led = new LedgerService([SPOT]);
      // 로컬 반영 흉내: 1~3을 seen-set에 등록(멱등 적용). 워터마크는 0 유지(tailer 관점 미소비).
      for (const s of [1, 2, 3]) led.applyJournal(toEntry(store[s - 1] as never));
      expect(bal(led)).toBe(30_00000000n);

      const prisma = fakePrisma(store);
      const tailer = new JournalTailer(prisma, led, AVAILABLE);
      const t = await tailer.tick();

      const { fullSeqs, fullCalls } = fetchCalls(prisma);
      expect(fullSeqs).toEqual([4]); // 자기-행 1~3은 재fetch 없음, 외부 seq4만
      expect(fullCalls).toHaveLength(1); // 2차 fetch는 라운드당 1회
      expect(t.duplicates).toBe(3); // 1~3 헤더 소비(seen-set) — 재적용 없음
      expect(t.applied).toBe(1); // seq4만 적용
      expect(t.watermark).toBe(4);
      expect(bal(led)).toBe(37_00000000n);
    });

    it('전부 로컬 적용분이면 2차 fetch 자체가 없다 (O(외부 유입)=0)', async () => {
      const store = [row(1, '10'), row(2, '10')];
      const led = new LedgerService([SPOT]);
      for (const s of [1, 2]) led.applyJournal(toEntry(store[s - 1] as never));

      const prisma = fakePrisma(store);
      const tailer = new JournalTailer(prisma, led, AVAILABLE);
      const t = await tailer.tick();

      const { fullCalls } = fetchCalls(prisma);
      expect(fullCalls).toHaveLength(0); // full-fetch 전무
      expect(t.applied).toBe(0);
      expect(t.duplicates).toBe(2);
      expect(t.watermark).toBe(2); // 헤더만으로 워터마크 전진
    });
  });

  describe('tick gap semantics (갭 스킵 + 워터마크 전진)', () => {
    it('holds watermark before a gap, then skips a dead (rolled-back) seq after grace', async () => {
      // seq 4 영구 결번 (롤백 소각). grace=2.
      const store = [row(1, '10'), row(2, '10'), row(3, '10'), row(5, '10'), row(6, '10')];
      const led = new LedgerService([SPOT]);
      const tailer = new JournalTailer(fakePrisma(store), led, AVAILABLE, 2);

      const t1 = await tailer.tick();
      expect(t1.applied).toBe(5); // 5건 전부 가환 적용 (갭 너머 5,6 포함)
      expect(t1.watermark).toBe(3); // 갭(4) 직전에 정지
      expect(t1.skippedGaps).toEqual([]);
      expect(bal(led)).toBe(50_00000000n);

      const t2 = await tailer.tick();
      expect(t2.duplicates).toBe(2); // 5,6 재질의 → seen-set no-op (이중 적용 없음)
      expect(t2.applied).toBe(0);
      expect(t2.skippedGaps).toEqual([4]); // grace 경과 → 소각 seq 스킵
      expect(t2.watermark).toBe(6);
      expect(bal(led)).toBe(50_00000000n); // 이중 적용 없이 불변
    });

    it('applies a gap that commits within grace (not skipped)', async () => {
      const store: Row[] = [row(1, '10'), row(2, '10'), row(3, '10'), row(5, '10')];
      const led = new LedgerService([SPOT]);
      const tailer = new JournalTailer(fakePrisma(store), led, AVAILABLE, 2);

      const t1 = await tailer.tick();
      expect(t1.watermark).toBe(3); // seq4 아직 미커밋 → 대기
      expect(t1.skippedGaps).toEqual([]);

      store.push(row(4, '10')); // grace 내에 seq4 커밋됨

      const t2 = await tailer.tick();
      expect(t2.applied).toBe(1); // seq4 적용
      expect(t2.skippedGaps).toEqual([]); // 스킵 아님
      expect(t2.watermark).toBe(5);
      expect(bal(led)).toBe(50_00000000n);
    });
  });
});
