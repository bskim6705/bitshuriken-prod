import { Injectable } from '@nestjs/common';
import { MarketType, Order } from '@prisma/client';

function keyOf(market: MarketType, symbol: string): string {
  return `${market}:${symbol}`;
}

/**
 * 미트리거 stop 주문 in-memory 인덱스. 순수 자료구조 — 의존성 없음.
 * 트리거/취소 판정의 진실은 DB guarded claim, 여기는 후보 탐색용.
 */
@Injectable()
export class TriggerRegistryService {
  private readonly bySymbol = new Map<string, Map<string, Order>>();
  private readonly keyByOrderId = new Map<string, string>();

  add(order: Order): void {
    const key = keyOf(order.tickerMarket, order.tickerSymbol);
    let bucket = this.bySymbol.get(key);
    if (!bucket) {
      bucket = new Map();
      this.bySymbol.set(key, bucket);
    }
    bucket.set(order.id, order);
    this.keyByOrderId.set(order.id, key);
  }

  remove(orderId: string): void {
    const key = this.keyByOrderId.get(orderId);
    if (key === undefined) return;
    this.keyByOrderId.delete(orderId);
    const bucket = this.bySymbol.get(key);
    if (!bucket) return;
    bucket.delete(orderId);
    if (bucket.size === 0) this.bySymbol.delete(key);
  }

  pendingFor(market: MarketType, symbol: string): Order[] {
    const bucket = this.bySymbol.get(keyOf(market, symbol));
    if (!bucket) return [];
    return [...bucket.values()];
  }

  size(): number {
    return this.keyByOrderId.size;
  }
}
