import { MarketType, OrderSide } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { TickerStatsService } from './ticker-stats.service';

const AVG_PRICE_WINDOW_MS = 5 * 60 * 1000;

// avgPrice5m incremental(롤링 합) == recompute(전 윈도 재합산) 동치성 검증.
// applyTrade/avgPrice5m는 Prisma 미사용이라 stub으로 충분.
describe('TickerStatsService.avgPrice5m (incremental == recompute)', () => {
  const T0 = 1_700_000_000_000; // 고정 기준 epoch ms
  let nowMs: number;

  beforeEach(() => {
    nowMs = T0;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => jest.restoreAllMocks());

  function mkService(): TickerStatsService {
    const svc = new TickerStatsService({} as unknown as PrismaService);
    for (const [market, symbol] of [
      [MarketType.SPOT, 'BTCUSDT'],
      [MarketType.SPOT, 'ETHUSDT'],
      [MarketType.FUTURES, 'BTCUSDT'],
    ] as const) {
      svc.upsertMetaFromControl(market, {
        symbol,
        baseAsset: symbol.replace('USDT', ''),
        quoteAsset: 'USDT',
        pricePrecision: 2,
        qtyPrecision: 8,
        minNotional: '0',
      });
    }
    return svc;
  }

  function apply(
    svc: TickerStatsService,
    market: MarketType,
    symbol: string,
    price: string,
    qty: string,
    ts: number,
  ): void {
    svc.applyTrade({
      market,
      symbol,
      tradeId: `${ts}-${price}`,
      price: new Decimal(price),
      qty: new Decimal(qty),
      takerSide: OrderSide.BUY,
      ts,
    });
  }

  // 구(舊) 알고리즘 그대로: tail→head 스캔, cutoff 미만이면 break. private state 직접 읽음.
  function recomputeAvg5m(
    svc: TickerStatsService,
    market: MarketType,
    symbol: string,
    pricePrecision = 2,
  ): string | null {
    const state = (svc as any).state.get(`${market}:${symbol}`);
    if (!state) return null;
    const cutoff = nowMs - AVG_PRICE_WINDOW_MS;
    let qty = new Decimal(0);
    let notional = new Decimal(0);
    for (let i = state.trades.length - 1; i >= 0; i--) {
      const t = state.trades[i];
      if (t.createdAt < cutoff) break;
      qty = qty.add(t.qty);
      notional = notional.add(t.price.mul(t.qty));
    }
    if (!qty.isZero()) return notional.div(qty).toFixed(pricePrecision);
    return state.lastPrice ? state.lastPrice.toFixed(pricePrecision) : null;
  }

  function stateOf(svc: TickerStatsService, market: MarketType, symbol: string): any {
    return (svc as any).state.get(`${market}:${symbol}`);
  }

  it('미상장/체결없음 심볼은 null', () => {
    const svc = mkService();
    expect(svc.avgPrice5m(MarketType.SPOT, 'DOGEUSDT')).toBeNull(); // meta 없음
    expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBeNull(); // state 없음
  });

  it('단일 체결이면 그 가격', () => {
    const svc = mkService();
    apply(svc, MarketType.SPOT, 'BTCUSDT', '100.00', '1', T0);
    expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBe('100.00');
    expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBe(
      recomputeAvg5m(svc, MarketType.SPOT, 'BTCUSDT'),
    );
  });

  it('윈도 내 다중 체결 = qty 가중평균, recompute와 동일', () => {
    const svc = mkService();
    apply(svc, MarketType.SPOT, 'BTCUSDT', '100.00', '1', T0);
    apply(svc, MarketType.SPOT, 'BTCUSDT', '200.00', '2', T0 + 100_000);
    nowMs = T0 + 100_000;
    // (100*1 + 200*2)/(1+2) = 500/3 = 166.666...
    expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBe('166.67');
    expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBe(
      recomputeAvg5m(svc, MarketType.SPOT, 'BTCUSDT'),
    );
  });

  it('eviction 경계: createdAt == cutoff는 포함, cutoff 미만이면 제외', () => {
    const svc = mkService();
    apply(svc, MarketType.SPOT, 'BTCUSDT', '100.00', '1', T0); // A
    apply(svc, MarketType.SPOT, 'BTCUSDT', '200.00', '2', T0 + 100_000); // B

    // now = T0 + 300_000 → cutoff = T0. A.createdAt(T0) == cutoff → 포함.
    nowMs = T0 + AVG_PRICE_WINDOW_MS;
    expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBe('166.67');
    expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBe(
      recomputeAvg5m(svc, MarketType.SPOT, 'BTCUSDT'),
    );

    // now = T0 + 300_001 → cutoff = T0+1. A(T0) < cutoff → 제외, B만.
    nowMs = T0 + AVG_PRICE_WINDOW_MS + 1;
    expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBe('200.00');
    expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBe(
      recomputeAvg5m(svc, MarketType.SPOT, 'BTCUSDT'),
    );
    const st = stateOf(svc, MarketType.SPOT, 'BTCUSDT');
    expect(st.avg5mHead).toBe(1); // A 하나 evict
    expect(st.qtySum5m.toString()).toBe('2'); // B qty만
  });

  it('빈 윈도: 5분 내 체결 없으면 lastPrice, 롤링 합은 정확히 0으로 리셋(드리프트 가드)', () => {
    const svc = mkService();
    apply(svc, MarketType.SPOT, 'BTCUSDT', '100.00', '1', T0);
    apply(svc, MarketType.SPOT, 'BTCUSDT', '200.00', '2', T0 + 100_000);

    // 모든 체결이 5분 밖. lastPrice(=B=200) 반환.
    nowMs = T0 + 100_000 + AVG_PRICE_WINDOW_MS + 1;
    expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBe('200.00');
    expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBe(
      recomputeAvg5m(svc, MarketType.SPOT, 'BTCUSDT'),
    );

    const st = stateOf(svc, MarketType.SPOT, 'BTCUSDT');
    expect(st.qtySum5m.isZero()).toBe(true);
    expect(st.qtySum5m.toString()).toBe('0');
    expect(st.notionalSum5m.toString()).toBe('0');
    expect(st.avg5mHead).toBe(st.trades.length);

    // 리셋 후 새 체결이 들어오면 잔차 없이 그 가격 그대로.
    apply(svc, MarketType.SPOT, 'BTCUSDT', '300.00', '5', nowMs);
    expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBe('300.00');
    expect(stateOf(svc, MarketType.SPOT, 'BTCUSDT').qtySum5m.toString()).toBe('5');
  });

  it('심볼 간 롤링 합은 독립 (interleaved)', () => {
    const svc = mkService();
    apply(svc, MarketType.SPOT, 'BTCUSDT', '100.00', '1', T0);
    apply(svc, MarketType.SPOT, 'ETHUSDT', '10.00', '4', T0 + 1_000);
    apply(svc, MarketType.SPOT, 'BTCUSDT', '110.00', '3', T0 + 2_000);
    apply(svc, MarketType.FUTURES, 'BTCUSDT', '99.00', '2', T0 + 3_000);
    apply(svc, MarketType.SPOT, 'ETHUSDT', '12.00', '6', T0 + 4_000);
    nowMs = T0 + 4_000;

    // SPOT BTC: (100*1 + 110*3)/(1+3) = 430/4 = 107.50
    expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBe('107.50');
    // SPOT ETH: (10*4 + 12*6)/(4+6) = 112/10 = 11.20
    expect(svc.avgPrice5m(MarketType.SPOT, 'ETHUSDT')).toBe('11.20');
    // FUTURES BTC: 99.00
    expect(svc.avgPrice5m(MarketType.FUTURES, 'BTCUSDT')).toBe('99.00');

    for (const [m, s] of [
      [MarketType.SPOT, 'BTCUSDT'],
      [MarketType.SPOT, 'ETHUSDT'],
      [MarketType.FUTURES, 'BTCUSDT'],
    ] as const) {
      expect(svc.avgPrice5m(m, s)).toBe(recomputeAvg5m(svc, m, s));
    }
  });

  it('24h shift가 일어나도 avg5mHead 정렬 유지', () => {
    const svc = mkService();
    apply(svc, MarketType.SPOT, 'BTCUSDT', '100.00', '1', T0); // 24h 뒤 evict 대상

    nowMs = T0 + 25 * 60 * 60 * 1000; // +25h → 위 체결은 24h 밖
    apply(svc, MarketType.SPOT, 'BTCUSDT', '500.00', '2', nowMs); // Y (shift 트리거)
    apply(svc, MarketType.SPOT, 'BTCUSDT', '600.00', '3', nowMs); // Z

    const st = stateOf(svc, MarketType.SPOT, 'BTCUSDT');
    expect(st.trades.length).toBe(2); // 최초 체결은 shift로 제거

    // (500*2 + 600*3)/(2+3) = 2800/5 = 560.00
    expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBe('560.00');
    expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBe(
      recomputeAvg5m(svc, MarketType.SPOT, 'BTCUSDT'),
    );
    expect(st.qtySum5m.toString()).toBe('5');
  });

  it('장기 스트림: 매 스텝 incremental == recompute (subtract-on-evict 정확성)', () => {
    const svc = mkService();
    // 까다로운 소수 가격/수량으로 mul·add·sub 누적 정확성 스트레스.
    const prices = ['123.45', '99.99', '150.00', '88.71', '133.33', '200.01', '175.50'];
    const qtys = ['0.7', '1.3', '0.05', '2.4', '0.11', '3.33', '0.9'];

    let ts = T0;
    for (let i = 0; i < 60; i++) {
      ts += 20_000; // 20초 간격 → 5분 윈도는 ~15체결 유지, 상시 eviction
      nowMs = ts;
      apply(
        svc,
        MarketType.SPOT,
        'BTCUSDT',
        prices[i % prices.length],
        qtys[i % qtys.length],
        ts,
      );
      expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBe(
        recomputeAvg5m(svc, MarketType.SPOT, 'BTCUSDT'),
      );
    }

    // 윈도 전체를 지나가도록 시간 점프 → 완전 소진 후 정확히 0 리셋 확인.
    nowMs = ts + 10 * 60 * 1000;
    expect(svc.avgPrice5m(MarketType.SPOT, 'BTCUSDT')).toBe(
      recomputeAvg5m(svc, MarketType.SPOT, 'BTCUSDT'),
    );
    const st = stateOf(svc, MarketType.SPOT, 'BTCUSDT');
    expect(st.qtySum5m.toString()).toBe('0');
    expect(st.notionalSum5m.toString()).toBe('0');
  });
});
