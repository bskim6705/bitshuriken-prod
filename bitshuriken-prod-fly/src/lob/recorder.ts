import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '../core/logger';
import { lobDir } from '../brain/paths';
import { type LobSample, mid, toTradeRows } from './sample';
import { LobStream } from './stream';

export const SAMPLE_MS = 1_000;
export const DEPTH_LEVELS = 20;

/** 초 정렬 샘플러: 매 초 최신 북 + 그 사이 체결을 하나의 LobSample로. 북이 없으면(연결 전) 건너뛴다. */
export class LobSampler {
  private timer: NodeJS.Timeout | null = null;
  private lastT = 0;

  constructor(
    readonly stream: LobStream,
    private readonly onSample: (s: LobSample) => void,
  ) {}

  start(): void {
    const tick = (): void => {
      const now = Date.now();
      const t = Math.floor(now / SAMPLE_MS) * SAMPLE_MS;
      const book = this.stream.book;
      const { trades, depthMsgs } = this.stream.take();
      if (book && t > this.lastT) {
        this.lastT = t;
        this.onSample({ t, bids: book.bids, asks: book.asks, trades: toTradeRows(trades), depthMsgs });
      }
      const next = SAMPLE_MS - (Date.now() % SAMPLE_MS) + 20; // 초 경계 직후
      this.timer = setTimeout(tick, next);
    };
    tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** data/lob/<SYMBOL>/<YYYY-MM-DD>.jsonl (UTC), 한 줄 = 1초. */
export function recordingPath(symbol: string, t: number): string {
  return join(lobDir(symbol), `${new Date(t).toISOString().slice(0, 10)}.jsonl`);
}

export class LobRecorder {
  private readonly stream: LobStream;
  private readonly sampler: LobSampler;
  private samples = 0;
  private tradesSeen = 0;
  private lastReport = Date.now();

  constructor(
    readonly symbol: string,
    private readonly log: Logger,
  ) {
    this.stream = new LobStream(symbol, DEPTH_LEVELS, log);
    this.sampler = new LobSampler(this.stream, (s) => this.write(s));
  }

  start(): void {
    mkdirSync(lobDir(this.symbol), { recursive: true });
    this.stream.start();
    this.sampler.start();
    this.log.ok(`recording ${this.symbol} at ${SAMPLE_MS}ms → ${lobDir(this.symbol)}`);
  }

  stop(): void {
    this.sampler.stop();
    this.stream.stop();
    this.log.info(`recorded ${this.samples} samples, ${this.tradesSeen} trades`);
  }

  private write(s: LobSample): void {
    appendFileSync(recordingPath(this.symbol, s.t), JSON.stringify(s) + '\n');
    this.samples++;
    this.tradesSeen += s.trades.length;
    if (Date.now() - this.lastReport >= 60_000) {
      this.lastReport = Date.now();
      const spread = s.asks.length && s.bids.length ? ((s.asks[0]![0] - s.bids[0]![0]) / mid(s)) * 1e4 : NaN;
      this.log.info(`${this.samples} samples | mid ${mid(s).toFixed(2)} spread ${spread.toFixed(2)}bps | depth ${s.bids.length}/${s.asks.length} lv | ${this.tradesSeen} trades | ${s.depthMsgs} depth msg/s`);
    }
  }
}
