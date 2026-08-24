import { OrderSide } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { assertWithinMaxNotional, OpenOrderQtyRow } from './futures-order-validation';

// 방향별 노출 캡 pure spec. 노출 = 같은 방향 포지션 + 같은 방향 미체결 잔량 + 신규.
// 반대 방향은 세지도, 상쇄하지도 않는다.

const d = (v: number | string) => new Decimal(v);

const order = (side: OrderSide, price: number, qty: number, executed = 0): OpenOrderQtyRow => ({
  side,
  price: d(price),
  origQty: d(qty),
  executedQty: d(executed),
});

const call = (p: {
  posQty?: number;
  openOrders?: OpenOrderQtyRow[];
  newSide: OrderSide;
  newNotional: number;
  maxNotional?: number;
}) =>
  assertWithinMaxNotional({
    position: p.posQty === undefined ? null : { qty: d(p.posQty) },
    mark: d(100),
    openOrders: p.openOrders ?? [],
    newSide: p.newSide,
    newNotional: d(p.newNotional),
    maxNotional: d(p.maxNotional ?? 1_000),
  });

describe('assertWithinMaxNotional (방향별)', () => {
  it('같은 방향 누적이 캡을 넘으면 거절한다', () => {
    expect(() =>
      call({ posQty: 5, openOrders: [order(OrderSide.BUY, 100, 4)], newSide: OrderSide.BUY, newNotional: 200 }),
    ).toThrow(/BUY exposure/); // 500 + 400 + 200 > 1000
  });

  it('반대 방향 미체결은 노출에 세지 않는다 (MM 양측 호가)', () => {
    // SELL 잔량 900 + 포지션 0에서 BUY 900은 방향 무시 합산이면 거절, 방향별이면 통과
    expect(() =>
      call({ openOrders: [order(OrderSide.SELL, 100, 9)], newSide: OrderSide.BUY, newNotional: 900 }),
    ).not.toThrow();
  });

  it('반대 방향 포지션은 노출에 세지 않는다 (숏 보유 중 BUY)', () => {
    expect(() => call({ posQty: -9, newSide: OrderSide.BUY, newNotional: 900 })).not.toThrow();
  });

  it('반대 방향 포지션이 상쇄해 주지도 않는다 (보수적)', () => {
    // 숏 500이 있어도 BUY 노출은 순수 매수 잔량+신규로만 계산되어 캡을 넘으면 거절
    expect(() =>
      call({ posQty: -5, openOrders: [order(OrderSide.BUY, 100, 6)], newSide: OrderSide.BUY, newNotional: 500 }),
    ).toThrow(/BUY exposure/); // 600 + 500 > 1000 (숏 500 상쇄 없음)
  });

  it('같은 방향 포지션은 노출에 든다', () => {
    expect(() => call({ posQty: 9, newSide: OrderSide.BUY, newNotional: 200 })).toThrow(/BUY exposure/);
    expect(() => call({ posQty: 9, newSide: OrderSide.SELL, newNotional: 200 })).not.toThrow();
  });

  it('부분 체결 잔량만 센다', () => {
    expect(() =>
      call({ openOrders: [order(OrderSide.BUY, 100, 10, 8)], newSide: OrderSide.BUY, newNotional: 700 }),
    ).not.toThrow(); // 잔량 2×100 + 700 ≤ 1000
  });

  it('가격 없는 주문(MARKET류)은 mark로 평가한다', () => {
    const noPrice: OpenOrderQtyRow = { side: OrderSide.BUY, price: null, origQty: d(5), executedQty: d(0) };
    expect(() => call({ openOrders: [noPrice], newSide: OrderSide.BUY, newNotional: 600 })).toThrow(
      /BUY exposure/,
    ); // 5×mark(100) + 600 > 1000
  });
});
