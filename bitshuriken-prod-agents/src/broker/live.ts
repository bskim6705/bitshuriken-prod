import type { SubaccountClient } from '../core/exchange';
import { ApiError } from '../core/exchange';
import { makeLogger, type Logger } from '../core/logger';
import { floorQty, meetsMinNotional, roundPrice, toFixedStr } from '../core/precision';
import type { Market, SymbolSpec } from '../core/types';
import type { ExecutionContext, Fill, OrderIntent, Position } from '../strategy/types';
import { apiBase } from '../config';

/** user stream executionReport (필요 필드만). 수량/가격은 display string. */
interface StreamReport {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type?: string;
  timeInForce?: string;
  status: string;
  lastFilledQty?: string | null;
  lastFilledPrice?: string | null;
  commission?: string | null;
  commissionAsset?: string | null;
  tradeId?: string | null;
  ts: number;
}

/** Node ≥22 전역 WebSocket(undici)의 최소 표면 — 별도 ws 의존성 없이 사용. */
interface WsLike {
  addEventListener(type: 'message', cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', cb: () => void): void;
  close(): void;
}

const STREAM_KEEPALIVE_MS = 30 * 60 * 1000; // listenKey TTL 60분의 절반
const STREAM_RECONNECT_MS = 3_000;

/**
 * Live ExecutionContext: routes a strategy's intents to the local exchange as the
 * agent's subaccount (HMAC REST). Position + equity are resynced from the subaccount's
 * own balances each bar (source of truth), so a missed order response self-heals.
 */
export class LiveBroker implements ExecutionContext {
  readonly market: Market;
  readonly log: Logger;
  private pos: Position = { qty: 0, avgEntry: 0 };
  private quoteTotal: number;
  private mark = 0;
  private fillCb: ((f: Fill) => void) | null = null;
  private baseFree = 0; // free base balance, decremented as SELLs are placed within a bar
  private fillsSeeded = false;
  private seenFills = new Set<string>(); // delivered trade ids (dedup, same-ms safe)
  private streamWs: WsLike | null = null;
  private streamStopped = false;

  constructor(
    readonly spec: SymbolSpec,
    private readonly client: SubaccountClient,
    initialCapital: number,
  ) {
    this.market = spec.market;
    this.quoteTotal = initialCapital;
    this.log = makeLogger(`live:${spec.symbol}`);
  }

  onFill(cb: (f: Fill) => void): void {
    this.fillCb = cb;
  }

  position(): Position {
    return { ...this.pos };
  }
  equityUsdt(): number {
    return this.quoteTotal + this.pos.qty * this.mark;
  }
  now(): number {
    return Date.now();
  }

  /** resync quote + base balances and the current mark before each decision. Throws on
   *  a failed read so the agent surfaces a persistent auth/balance problem (not silent). */
  async refresh(mark: number): Promise<void> {
    this.mark = mark;
    const bals = await this.client.balances(this.market);
    const sum = (asset: string): number =>
      bals.filter((b) => b.asset === asset).reduce((a, b) => a + Number(b.free) + Number(b.locked), 0);
    this.quoteTotal = sum(this.spec.quoteAsset);
    const base = sum(this.spec.baseAsset);
    this.baseFree = bals.filter((b) => b.asset === this.spec.baseAsset).reduce((a, b) => a + Number(b.free), 0);
    this.pos = { qty: base, avgEntry: base > 0 ? this.pos.avgEntry : 0 };
    if (this.fillCb) await this.pollFills(); // deliver resting-limit fills (grid / market-making)
  }

  /**
   * user data stream 연결 — executionReport의 체결을 즉시 onFill로 전달한다 (per-bar 폴링은
   * 안전망으로 유지, trade id 디덥으로 이중 전달 없음). 전역 WebSocket(Node ≥22)이 없거나
   * 연결이 실패해도 치명 아님: 종전 폴링만으로 동작한다.
   */
  async connectUserStream(): Promise<void> {
    const WS = (globalThis as { WebSocket?: new (url: string) => WsLike }).WebSocket;
    if (!WS) {
      this.log.warn('global WebSocket unavailable — fills stay poll-only');
      return;
    }
    void this.streamLoop(WS);
  }

  private async streamLoop(WS: new (url: string) => WsLike): Promise<void> {
    while (!this.streamStopped) {
      try {
        const key = await this.client.createListenKey(this.market);
        const keepalive = setInterval(() => {
          void this.client
            .keepaliveListenKey(this.market, key)
            .catch((e: unknown) => this.log.warn('listenKey keepalive failed', (e as Error).message));
        }, STREAM_KEEPALIVE_MS);
        try {
          await this.runStream(WS, key);
        } finally {
          clearInterval(keepalive);
        }
      } catch (e) {
        this.log.warn('user stream error', (e as Error).message);
      }
      if (this.streamStopped) return;
      await new Promise((r) => setTimeout(r, STREAM_RECONNECT_MS));
    }
  }

  /** 소켓이 닫힐 때 resolve — 루프가 키 재발급 후 재접속. */
  private runStream(WS: new (url: string) => WsLike, listenKey: string): Promise<void> {
    return new Promise((resolve) => {
      const path = this.market === 'SPOT' ? '/ws/user' : '/ws/fuser';
      const ws = new WS(`${apiBase(this.market).replace(/^http/, 'ws')}${path}?listenKey=${listenKey}`);
      this.streamWs = ws;
      ws.addEventListener('message', (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { stream?: string; data?: StreamReport };
          if (msg.stream === 'executionReport' && msg.data) this.onStreamReport(msg.data);
        } catch {
          /* 형식 밖 메시지 무시 */
        }
      });
      ws.addEventListener('error', () => {
        /* close가 뒤따른다 */
      });
      ws.addEventListener('close', () => resolve());
    });
  }

  /** 스트림 체결 → Fill. 실시간 이벤트라 히스토리 재생이 없고, trade id로 폴링과 상호 디덥. */
  private onStreamReport(r: StreamReport): void {
    if (r.symbol !== this.spec.symbol || !r.tradeId || !r.lastFilledQty) return;
    if (this.seenFills.has(r.tradeId)) return;
    this.seenFills.add(r.tradeId);
    const price = Number(r.lastFilledPrice ?? 0);
    const commission = Number(r.commission ?? 0);
    const fee = r.commissionAsset === this.spec.quoteAsset ? commission : commission * price;
    this.fillCb?.({
      orderId: r.orderId,
      side: r.side,
      price,
      qty: Number(r.lastFilledQty),
      fee,
      feeAsset: r.commissionAsset ?? this.spec.quoteAsset,
      // 근사: 리포트에 maker 플래그가 없다 — resting형 주문(POST_ONLY/GTC LIMIT)을 maker로 간주
      isMaker: r.type === 'POST_ONLY' || (r.type === 'LIMIT' && r.timeInForce === 'GTC'),
      time: r.ts,
    });
  }

  /** 스트림 종료 (agent stop). */
  dispose(): void {
    this.streamStopped = true;
    this.streamWs?.close();
  }

  /** poll own trades and deliver newly-seen ones as onFill events, deduped by trade id
   *  (same-ms / self-trade safe). The first poll only seeds the seen-set (no history replay). */
  private async pollFills(): Promise<void> {
    const batch = await this.client.trades(this.market, { symbol: this.spec.symbol, limit: 100 });
    const fresh = batch.filter((t) => !this.seenFills.has(t.id));
    for (const t of fresh) this.seenFills.add(t.id);
    if (this.seenFills.size > 5000) this.seenFills = new Set([...this.seenFills].slice(-2000)); // keep most-recent ids
    if (!this.fillsSeeded) {
      this.fillsSeeded = true;
      return;
    }
    if (batch.length === 100 && fresh.length === 100) this.log.warn('fill page saturated — raise poll rate or some fills may be missed');
    for (const t of fresh.sort((a, b) => a.time - b.time)) {
      const price = Number(t.price);
      const commission = Number(t.commission);
      const fee = t.commissionAsset === this.spec.quoteAsset ? commission : commission * price;
      this.fillCb?.({
        orderId: t.orderId,
        side: t.isBuyer ? 'BUY' : 'SELL',
        price,
        qty: Number(t.qty),
        fee,
        feeAsset: t.commissionAsset,
        isMaker: t.isMaker,
        time: t.time,
      });
    }
  }

  async submit(intent: OrderIntent): Promise<string | null> {
    try {
      switch (intent.kind) {
        case 'MARKET':
          return await this.market_(intent.side, intent.qty);
        case 'MARKET_QUOTE':
          return await this.marketQuote(intent.side, intent.quoteQty);
        case 'LIMIT':
          return await this.limit(intent.side, intent.price, intent.qty, intent.postOnly === true);
        case 'FLATTEN':
          if (this.pos.qty > 0) await this.market_('SELL', this.pos.qty);
          return null;
        case 'CANCEL':
          await this.client.cancel(this.market, intent.orderId);
          return null;
      }
    } catch (e) {
      if (!(e instanceof ApiError)) this.log.warn('submit failed', (e as Error).message);
      else this.log.warn(`submit rejected: ${e.message}`);
      return null;
    }
  }

  private async market_(side: 'BUY' | 'SELL', qty: number): Promise<string | null> {
    if (side === 'SELL') qty = Math.min(qty, this.baseFree); // long-only: never sell more than free base
    const baseQty = floorQty(this.spec, qty);
    if (Number(baseQty) <= 0 || !meetsMinNotional(this.spec, this.mark, Number(baseQty))) return null;
    const quoteQty = toFixedStr(Number(baseQty) * this.mark, this.spec.pricePrecision);
    const order = await this.client.placeMarket(this.spec, side, baseQty, quoteQty);
    if (side === 'SELL') this.baseFree -= Number(baseQty);
    this.applyOrder(side, order);
    return order.id;
  }

  private async marketQuote(side: 'BUY' | 'SELL', quoteQty: number): Promise<string | null> {
    if (side === 'SELL') {
      // size from quote like the sim broker, capped to the held position (parity)
      const baseQty = Math.min(Number(floorQty(this.spec, quoteQty / (this.mark || 1))), this.pos.qty);
      return this.market_('SELL', baseQty);
    }
    const q = toFixedStr(quoteQty, this.spec.pricePrecision);
    if (Number(q) < this.spec.minNotional) return null;
    const baseGuess = floorQty(this.spec, quoteQty / (this.mark || 1));
    const order = await this.client.placeMarket(this.spec, 'BUY', baseGuess, q);
    this.applyOrder('BUY', order);
    return order.id;
  }

  private async limit(
    side: 'BUY' | 'SELL',
    price: number,
    qty: number,
    postOnly: boolean,
  ): Promise<string | null> {
    if (side === 'SELL') qty = Math.min(qty, this.baseFree); // long-only: cap to free base inventory
    const p = roundPrice(this.spec, price);
    const baseQty = floorQty(this.spec, qty);
    if (Number(baseQty) <= 0 || !meetsMinNotional(this.spec, Number(p), Number(baseQty))) return null;
    const order = await this.client.placeLimit(this.spec, side, p, baseQty, postOnly ? 'POST_ONLY' : 'LIMIT');
    if (side === 'SELL') this.baseFree -= Number(baseQty);
    return order.id;
  }

  /** optimistically fold a market-order response into the local position so the strategy
   *  sees its fill within the same bar (the next refresh resyncs from balances). onFill is
   *  delivered separately by pollFills() to keep one fill source. */
  private applyOrder(side: 'BUY' | 'SELL', order: { executedQty?: string; cumulativeQuoteQty?: string | null }): void {
    const exec = Number(order.executedQty ?? 0);
    if (exec <= 0) return;
    const quote = Number(order.cumulativeQuoteQty ?? 0);
    const price = quote > 0 ? quote / exec : this.mark;
    if (side === 'BUY') {
      const cost = this.pos.avgEntry * this.pos.qty + price * exec;
      this.pos.qty += exec;
      this.pos.avgEntry = this.pos.qty > 0 ? cost / this.pos.qty : 0;
    } else {
      this.pos.qty = Math.max(0, this.pos.qty - exec);
      if (this.pos.qty === 0) this.pos.avgEntry = 0;
    }
  }
}
