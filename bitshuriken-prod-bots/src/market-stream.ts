import WebSocket from 'ws';
import { config } from './config';
import type { LocalExchangeClient } from './exchange';
import type { Level, Market } from './types';
import { makeLogger, type Logger } from './log';

/** BE `<sym>@depth@100ms` 엔벨로프. 레벨은 display string, qty 0 = 레벨 삭제. */
interface DiffMsg {
  symbol: string;
  firstUpdateId: number;
  finalUpdateId: number;
  prevFinalUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
  ts: number;
}

interface BookState {
  bids: Map<number, number>; // price → qty
  asks: Map<number, number>;
  lastUpdateId: number;
  synced: boolean;
  syncing: boolean;
  buffer: DiffMsg[]; // 스냅샷 도착 전 수신 diff
  lastEventAt: number;
}

const STALE_MS = 1_500; // 이보다 오래 조용하면 신선하지 않음 — 호출부가 REST로 후퇴
const RECONNECT_MS = 3_000;

/**
 * 로컬 거래소의 depth diff 스트림으로 심볼별 오더북을 유지한다 — 메이커 터치 read(pass당
 * REST depth(1))와 테이커 뎁스 폴(250ms REST depth(5))을 밀어내는 1차 소스.
 *
 * 동기화 레시피(diff 윈도는 (pu, u] 구간): 구독 후 REST 스냅샷(lastUpdateId=S) →
 * u ≤ S 윈도 버림 → 첫 적용 윈도는 pu ≤ S 필수(아니면 재스냅샷) → 이후 pu가 직전 u와
 * 불연속이면 재동기화. 레벨 qty는 절대값이라 S가 윈도 중간이어도 재적용은 멱등.
 */
export class MarketStream {
  private readonly books = new Map<string, BookState>();
  private ws: WebSocket | null = null;
  private stopped = false;
  private readonly log: Logger;

  constructor(
    private readonly client: LocalExchangeClient,
    private readonly market: Market,
    private readonly symbols: string[],
  ) {
    this.log = makeLogger(`mstream:${market === 'FUTURES' ? 'F' : 'S'}`);
    for (const s of symbols) this.books.set(s, emptyState());
  }

  start(): void {
    void this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  /** 신선한 로컬 북의 상위 n레벨. 미동기·수신 공백이면 null — 호출부가 REST로 후퇴. */
  book(symbol: string, n: number): { bids: Level[]; asks: Level[] } | null {
    const st = this.books.get(symbol);
    if (!st || !st.synced || Date.now() - st.lastEventAt > STALE_MS) return null;
    return { bids: topLevels(st.bids, 'desc', n), asks: topLevels(st.asks, 'asc', n) };
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.run();
      } catch (e) {
        this.log.warn('stream error', (e as Error).message);
      }
      if (this.stopped) return;
      for (const st of this.books.values()) resetState(st);
      await new Promise((r) => setTimeout(r, RECONNECT_MS));
    }
  }

  /** 소켓이 닫힐 때 resolve — 루프가 전 북 리셋 후 재접속·재동기화. */
  private run(): Promise<void> {
    return new Promise((resolve, reject) => {
      const base = this.market === 'SPOT' ? config.api.spot : config.api.futures;
      const path = this.market === 'SPOT' ? '/ws/market' : '/ws/fmarket';
      const ws = new WebSocket(`${base.replace(/^http/, 'ws')}${path}`);
      this.ws = ws;
      ws.on('open', () => {
        ws.send(
          JSON.stringify({
            method: 'SUBSCRIBE',
            streams: this.symbols.map((s) => `${s.toLowerCase()}@depth@100ms`),
            id: 1,
          }),
        );
      });
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw)) as { stream?: string; data?: DiffMsg };
          if (msg.stream?.endsWith('@depth@100ms') && msg.data) this.onDiff(msg.data);
        } catch {
          /* 형식 밖 메시지 무시 */
        }
      });
      ws.on('error', (e) => reject(e));
      ws.on('close', () => resolve());
    });
  }

  private onDiff(d: DiffMsg): void {
    const st = this.books.get(d.symbol);
    if (!st) return;
    st.lastEventAt = Date.now();
    if (!st.synced) {
      st.buffer.push(d);
      if (!st.syncing) void this.sync(d.symbol, st);
      return;
    }
    if (d.finalUpdateId <= st.lastUpdateId) return; // 재전송/역행 — 버림
    if (d.prevFinalUpdateId !== st.lastUpdateId) {
      this.log.warn(`${d.symbol} diff gap (pu=${d.prevFinalUpdateId} != ${st.lastUpdateId}) — resync`);
      resetState(st);
      st.buffer.push(d);
      void this.sync(d.symbol, st);
      return;
    }
    applyDiff(st, d);
  }

  private async sync(symbol: string, st: BookState): Promise<void> {
    st.syncing = true;
    try {
      const snap = await this.client.depth(this.market, symbol, 50);
      const snapId = snap.lastUpdateId ?? 0;
      st.bids = new Map(snap.bids);
      st.asks = new Map(snap.asks);
      st.lastUpdateId = snapId;
      // 버퍼 재생: u ≤ S 버림, 첫 적용 윈도는 pu ≤ S 필수
      for (const d of st.buffer.splice(0)) {
        if (d.finalUpdateId <= st.lastUpdateId) continue;
        if (d.prevFinalUpdateId > st.lastUpdateId) {
          this.log.warn(`${symbol} snapshot too old (pu=${d.prevFinalUpdateId} > ${st.lastUpdateId}) — retry`);
          resetState(st);
          st.buffer.push(d);
          setTimeout(() => void this.sync(symbol, st), 250);
          return;
        }
        applyDiff(st, d);
      }
      st.synced = true;
    } catch (e) {
      this.log.warn(`${symbol} snapshot failed — retrying`, (e as Error).message);
      setTimeout(() => void this.sync(symbol, st), 1_000);
      return;
    } finally {
      st.syncing = false;
    }
  }
}

function emptyState(): BookState {
  return {
    bids: new Map(),
    asks: new Map(),
    lastUpdateId: 0,
    synced: false,
    syncing: false,
    buffer: [],
    lastEventAt: 0,
  };
}

function resetState(st: BookState): void {
  st.bids.clear();
  st.asks.clear();
  st.lastUpdateId = 0;
  st.synced = false;
  st.buffer.length = 0;
}

function applyDiff(st: BookState, d: DiffMsg): void {
  for (const [p, q] of d.bids) setLevel(st.bids, p, q);
  for (const [p, q] of d.asks) setLevel(st.asks, p, q);
  st.lastUpdateId = d.finalUpdateId;
}

function setLevel(side: Map<number, number>, priceStr: string, qtyStr: string): void {
  const price = Number(priceStr);
  const qty = Number(qtyStr);
  if (qty <= 0) side.delete(price);
  else side.set(price, qty);
}

function topLevels(side: Map<number, number>, dir: 'asc' | 'desc', n: number): Level[] {
  const prices = [...side.keys()].sort((a, b) => (dir === 'asc' ? a - b : b - a));
  return prices.slice(0, n).map((p) => [p, side.get(p)!] as Level);
}
