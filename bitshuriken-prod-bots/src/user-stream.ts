import WebSocket from 'ws';
import { config } from './config';
import type { LocalExchangeClient } from './exchange';
import type { Market } from './types';
import { makeLogger, type Logger } from './log';

/** BE user stream의 executionReport(spot/futures 공통 필드만). 수량은 display string. */
export interface ExecutionReport {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  status: string;
  origQty?: string | null;
  executedQty: string;
  lastFilledQty?: string | null;
  ts: number;
}

const KEEPALIVE_MS = 30 * 60 * 1000; // listenKey TTL 60분의 절반
const RECONNECT_MS = 3_000;

/**
 * 한 봇 계정의 user data stream 소비자: listenKey 발급 → /ws/user(:fuser) 연결 →
 * executionReport를 콜백으로 전달. 폴링(resync)을 대체하는 1차 체결 소스 — 연결이 끊기면
 * 재발급·재접속하고, 그 공백은 기존 resync 안전망이 메운다.
 */
export class UserStream {
  private ws: WebSocket | null = null;
  private listenKey: string | null = null;
  private stopped = false;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private readonly log: Logger;

  constructor(
    private readonly client: LocalExchangeClient,
    private readonly market: Market,
    private readonly onReport: (r: ExecutionReport) => void,
    label: string,
  ) {
    this.log = makeLogger(`ustream:${label}`);
  }

  start(): void {
    void this.connectLoop();
    this.keepaliveTimer = setInterval(() => {
      if (!this.listenKey) return;
      void this.client
        .keepaliveListenKey(this.market, this.listenKey)
        .catch((e: unknown) => this.log.warn('keepalive failed', (e as Error).message));
    }, KEEPALIVE_MS);
  }

  private async connectLoop(): Promise<void> {
    while (!this.stopped) {
      try {
        this.listenKey = await this.client.createListenKey(this.market);
        await this.run(this.listenKey);
      } catch (e) {
        this.log.warn('stream error', (e as Error).message);
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, RECONNECT_MS));
    }
  }

  /** 소켓이 닫힐 때 resolve (키 만료·BE 재시작) — 호출부 루프가 재접속. */
  private run(listenKey: string): Promise<void> {
    return new Promise((resolve) => {
      const base = this.market === 'SPOT' ? config.api.spot : config.api.futures;
      const path = this.market === 'SPOT' ? '/ws/user' : '/ws/fuser';
      const ws = new WebSocket(`${base.replace(/^http/, 'ws')}${path}?listenKey=${listenKey}`);
      this.ws = ws;
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw)) as { stream?: string; data?: ExecutionReport };
          if (msg.stream === 'executionReport' && msg.data) this.onReport(msg.data);
        } catch {
          /* 형식 밖 메시지 무시 */
        }
      });
      ws.on('error', (e) => this.log.warn('ws error', e.message));
      ws.on('close', () => resolve());
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.ws?.close();
  }
}
