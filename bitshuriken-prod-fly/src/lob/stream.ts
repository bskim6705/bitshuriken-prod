import WebSocket from 'ws';
import { config } from '../config';
import type { Logger } from '../core/logger';

/** 호가 레벨 [price, qty] (숫자). */
export type Level = [number, number];

export interface Trade {
  ts: number;
  price: number;
  qty: number;
  side: 1 | -1; // taker side: +1 BUY, −1 SELL
}

export interface BookView {
  bids: Level[]; // 내림차순
  asks: Level[]; // 오름차순
  lastUpdateId: number;
  at: number; // 수신 시각 (ms)
}

interface DepthMsg {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}
interface TradeMsg {
  id: string;
  symbol: string;
  price: string;
  qty: string;
  side: 'BUY' | 'SELL';
  ts: number;
}

const RECONNECT_MS = 3_000;

/**
 * 로컬 거래소 `/ws/market` 구독: `<sym>@depth`(변경마다 전체 스냅샷 push, ~40/s)와 `<sym>@trade`.
 * 최신 북과 마지막 take 이후 체결을 보관한다 — 샘플러가 고정 주기로 가져간다.
 * 구독 직후 오는 체결 스냅샷(배열 50건, 과거)은 흐름으로 세지 않는다.
 */
export class LobStream {
  book: BookView | null = null;
  private trades: Trade[] = [];
  private depthMsgs = 0;
  private ws: WebSocket | null = null;
  private stopped = false;
  private connectedAt = 0;
  private tradeSnapshotSeen = false;

  constructor(
    readonly symbol: string,
    private readonly depthLevels: number,
    private readonly log: Logger,
  ) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  /** 마지막 호출 이후의 체결과 depth 메시지 수를 꺼내고 비운다. */
  take(): { trades: Trade[]; depthMsgs: number } {
    const out = { trades: this.trades, depthMsgs: this.depthMsgs };
    this.trades = [];
    this.depthMsgs = 0;
    return out;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.run();
      } catch (e) {
        this.log.warn('market stream error', (e as Error).message);
      }
      if (this.stopped) return;
      this.book = null;
      await new Promise((r) => setTimeout(r, RECONNECT_MS));
    }
  }

  private run(): Promise<void> {
    return new Promise((resolve, reject) => {
      const lower = this.symbol.toLowerCase();
      const ws = new WebSocket(`${config.api.spot.replace(/^http/, 'ws')}/ws/market`);
      this.ws = ws;
      this.tradeSnapshotSeen = false;
      ws.on('open', () => {
        this.connectedAt = Date.now();
        ws.send(JSON.stringify({ method: 'SUBSCRIBE', streams: [`${lower}@depth`, `${lower}@trade`], id: 1 }));
        this.log.info(`market stream connected (${lower}@depth, ${lower}@trade)`);
      });
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw)) as { stream?: string; data?: unknown };
          if (!msg.stream || msg.data === undefined) return;
          if (msg.stream.endsWith('@depth')) this.onDepth(msg.data as DepthMsg);
          else if (msg.stream.endsWith('@trade')) this.onTrades(msg.data as TradeMsg | TradeMsg[]);
        } catch {
          /* 형식 밖 메시지 무시 */
        }
      });
      ws.on('error', (e) => reject(e));
      ws.on('close', () => resolve());
    });
  }

  private onDepth(d: DepthMsg): void {
    const conv = (rows: [string, string][]): Level[] => {
      const out: Level[] = [];
      for (let i = 0; i < rows.length && out.length < this.depthLevels; i++) {
        const q = Number(rows[i]![1]);
        if (q > 0) out.push([Number(rows[i]![0]), q]);
      }
      return out;
    };
    this.book = { bids: conv(d.bids), asks: conv(d.asks), lastUpdateId: d.lastUpdateId, at: Date.now() };
    this.depthMsgs++;
  }

  private onTrades(d: TradeMsg | TradeMsg[]): void {
    const rows = Array.isArray(d) ? d : [d];
    if (Array.isArray(d) && !this.tradeSnapshotSeen) {
      this.tradeSnapshotSeen = true; // 구독 스냅샷(과거 50건) — 흐름 아님
      if (rows.length > 1 || rows[0]!.ts < this.connectedAt) return;
    }
    for (const t of rows) {
      if (t.ts < this.connectedAt - 2_000) continue;
      this.trades.push({ ts: t.ts, price: Number(t.price), qty: Number(t.qty), side: t.side === 'BUY' ? 1 : -1 });
    }
  }
}
