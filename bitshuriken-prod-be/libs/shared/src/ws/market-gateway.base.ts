import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { MarketType } from '@prisma/client';
import type { WebSocket } from 'ws';
import { TickerStatsService, TradeEvent } from '@app/core-domain/ticker/ticker-stats.service';
import { OrderBookCacheService } from '@app/core-domain/orderbook/orderbook-cache.service';
import { fmtScaled } from '../decimal';

interface SubscribeMsg {
  method?: 'SUBSCRIBE' | 'UNSUBSCRIBE';
  streams?: string[];
  id?: number;
}

export const ALL_TICKERS_STREAM = '!ticker@arr';
export const TRADE_SNAPSHOT_LIMIT = 50;
export const DEPTH_DIFF_SUFFIX = 'depth@100ms';
const THROTTLE_MS = 1000;
const DIFF_FLUSH_MS = 100;
const PING_INTERVAL_MS = 30_000;
const DEPTH_LEVELS = 50;
const WS_OPEN = 1;
// 백프레셔: 송신버퍼 DROP 초과 클라이언트는 해당 메시지 드롭(스트림 시퀀스로 감지 가능), KILL 초과는 종료
const BP_DROP_BYTES = 1 * 1024 * 1024;
const BP_KILL_BYTES = 8 * 1024 * 1024;

/** 엔진 DPD 1건 (raw int*10^8 string 레벨, 절대 qty — 0은 레벨 삭제). */
export interface DepthDiffEvent {
  lastUpdateId: number;
  ts: number;
  bids: [string, string][];
  asks: [string, string][];
}

/** 100ms 윈도 안에서 병합 중인 diff — 같은 가격 레벨은 나중 값이 이김(절대 qty). */
interface PendingDepthDiff {
  firstU: number;
  lastU: number;
  ts: number;
  bids: Map<string, string>;
  asks: Map<string, string>;
}

/**
 * 마켓 데이터 게이트웨이 공통 구현 — 연결 수명주기, SUBSCRIBE/UNSUBSCRIBE 프로토콜,
 * 구독 레지스트리, heartbeat(30s ping/pong), publish/send.
 * 스트림 파싱/스냅샷/1s tick 본문은 서브클래스 훅.
 */
export abstract class WsMarketGatewayBase
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  protected readonly logger = new Logger(this.constructor.name);

  protected readonly clients = new Set<WebSocket>();
  protected readonly subsByClient = new WeakMap<WebSocket, Set<string>>();
  protected readonly aliveByClient = new WeakMap<WebSocket, boolean>();
  protected readonly clientsByStream = new Map<string, Set<WebSocket>>();
  private secondTimer: NodeJS.Timeout | null = null;
  private diffTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private unsubscribeTrade: (() => void) | null = null;
  // depth diff 스트림 상태 — 심볼별 병합 버퍼 + 직전 송출 finalUpdateId(pu 연속성)
  private readonly pendingDiffBySymbol = new Map<string, PendingDepthDiff>();
  private readonly lastDiffU = new Map<string, number>();
  // 백프레셔 드롭 경고는 연결당 1회
  private readonly bpWarned = new WeakSet<WebSocket>();

  protected abstract readonly market: MarketType;
  protected abstract readonly tickerStats: TickerStatsService;
  protected abstract readonly obCache: OrderBookCacheService;

  /** 유효 스트림이면 truthy(파싱 결과), 아니면 null. */
  protected abstract parseAndValidate(stream: string): unknown;
  /** 구독 수락 직후 1회 스냅샷 push. */
  protected abstract sendSnapshot(client: WebSocket, stream: string): Promise<void>;
  /** 1s 스로틀 tick 본문. */
  protected abstract onSecondTick(): void;
  /** 추가 이벤트 구독 훅 — trade 구독 직후 호출. */
  protected onGatewayInit(): void {}
  /** 추가 이벤트 구독 해제 훅 — trade 구독 해제 직후 호출. */
  protected onGatewayDestroy(): void {}
  /** 스트림의 마지막 구독자가 빠졌을 때 정리 훅. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected onStreamEmpty(stream: string): void {}

  onModuleInit(): void {
    // Trade event는 settlement hot-path에서 방출되므로 setImmediate로 다음 tick 이월.
    this.unsubscribeTrade = this.tickerStats.onTrade((event) => {
      setImmediate(() => this.fanoutTrade(event));
    });
    this.onGatewayInit();
    this.secondTimer = setInterval(() => this.onSecondTick(), THROTTLE_MS);
    this.diffTimer = setInterval(() => this.flushDepthDiffs(), DIFF_FLUSH_MS);
    this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.unsubscribeTrade?.();
    this.onGatewayDestroy();
    if (this.secondTimer) clearInterval(this.secondTimer);
    if (this.diffTimer) clearInterval(this.diffTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
  }

  handleConnection(client: WebSocket): void {
    this.clients.add(client);
    this.subsByClient.set(client, new Set());
    this.aliveByClient.set(client, true);
    client.on('pong', () => this.aliveByClient.set(client, true));
    client.on('message', (raw: Buffer) => {
      void this.onMessage(client, raw);
    });
  }

  handleDisconnect(client: WebSocket): void {
    this.clients.delete(client);
    const subs = this.subsByClient.get(client);
    if (!subs) return;
    for (const stream of subs) {
      this.dropFromStream(client, stream);
    }
    this.subsByClient.delete(client);
  }

  // ---- incoming subscribe/unsubscribe ----

  private async onMessage(client: WebSocket, raw: Buffer): Promise<void> {
    let msg: SubscribeMsg;
    try {
      msg = JSON.parse(raw.toString('utf8')) as SubscribeMsg;
    } catch (err) {
      this.logger.warn(`bad message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const streams = Array.isArray(msg.streams) ? msg.streams : [];
    const id = typeof msg.id === 'number' ? msg.id : null;

    if (msg.method === 'SUBSCRIBE') {
      const accepted: string[] = [];
      const rejected: string[] = [];
      for (const stream of streams) {
        if (this.parseAndValidate(stream)) {
          this.subscribe(client, stream);
          accepted.push(stream);
        } else {
          rejected.push(stream);
        }
      }
      if (rejected.length > 0) {
        this.send(client, { error: 'invalid streams', streams: rejected, id });
      } else {
        this.send(client, { result: null, id });
      }
      // 스냅샷 실패가 unhandled rejection으로 프로세스를 죽이지 않게 가드
      for (const stream of accepted) {
        try {
          await this.sendSnapshot(client, stream);
        } catch (err) {
          this.logger.error(
            `snapshot failed for ${stream}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } else if (msg.method === 'UNSUBSCRIBE') {
      for (const stream of streams) this.unsubscribe(client, stream);
      this.send(client, { result: null, id });
    } else {
      this.send(client, { error: 'unknown method', id });
    }
  }

  private subscribe(client: WebSocket, stream: string): void {
    this.subsByClient.get(client)?.add(stream);
    let subs = this.clientsByStream.get(stream);
    if (!subs) {
      subs = new Set();
      this.clientsByStream.set(stream, subs);
    }
    subs.add(client);
  }

  private unsubscribe(client: WebSocket, stream: string): void {
    this.subsByClient.get(client)?.delete(stream);
    this.dropFromStream(client, stream);
  }

  /** 스트림에서 client 제거. 마지막 구독자였으면 빈 Set 정리 + onStreamEmpty 훅. */
  private dropFromStream(client: WebSocket, stream: string): void {
    const subs = this.clientsByStream.get(stream);
    if (!subs) return;
    subs.delete(client);
    if (subs.size === 0) {
      this.clientsByStream.delete(stream);
      this.onStreamEmpty(stream);
    }
  }

  // ---- heartbeat ----

  /** 30s마다 ping. 직전 ping에 pong이 없으면 종료. */
  private heartbeat(): void {
    for (const client of this.clients) {
      if (this.aliveByClient.get(client) === false) {
        client.terminate();
        continue;
      }
      this.aliveByClient.set(client, false);
      client.ping();
    }
  }

  // ---- depth diff stream (<sym>@depth@100ms) ----

  /**
   * DPD 1건을 심볼 윈도 버퍼에 병합. 100ms 타이머가 firstUpdateId(U)/finalUpdateId(u)/
   * prevFinalUpdateId(pu) 엔벨로프로 송출 — 클라이언트는 REST depth의 lastUpdateId로 동기화 후
   * u ≤ snapshot은 버리고, 이후 pu 불연속이면 재동기화한다. 구독자 없으면 pu 연속성만 유지.
   */
  protected bufferDepthDiff(symbol: string, diff: DepthDiffEvent): void {
    const stream = `${symbol.toLowerCase()}@${DEPTH_DIFF_SUFFIX}`;
    if (!this.clientsByStream.get(stream)?.size) {
      this.lastDiffU.set(symbol, diff.lastUpdateId);
      this.pendingDiffBySymbol.delete(symbol);
      return;
    }
    let pending = this.pendingDiffBySymbol.get(symbol);
    if (!pending) {
      pending = {
        firstU: diff.lastUpdateId,
        lastU: diff.lastUpdateId,
        ts: diff.ts,
        bids: new Map(),
        asks: new Map(),
      };
      this.pendingDiffBySymbol.set(symbol, pending);
    }
    pending.lastU = diff.lastUpdateId;
    pending.ts = diff.ts;
    for (const [p, q] of diff.bids) pending.bids.set(p, q);
    for (const [p, q] of diff.asks) pending.asks.set(p, q);
  }

  private flushDepthDiffs(): void {
    if (this.pendingDiffBySymbol.size === 0) return;
    for (const [symbol, pending] of this.pendingDiffBySymbol) {
      const stream = `${symbol.toLowerCase()}@${DEPTH_DIFF_SUFFIX}`;
      const pu = this.lastDiffU.get(symbol) ?? 0; // 0 = 이 프로세스가 본 직전 diff 없음
      this.lastDiffU.set(symbol, pending.lastU);
      const subs = this.clientsByStream.get(stream);
      if (!subs || subs.size === 0) continue;
      const meta = this.tickerStats.metaOf(this.market, symbol);
      if (!meta) continue;
      const fmt = ([p, q]: [string, string]): [string, string] => [
        fmtScaled(p, meta.pricePrecision),
        fmtScaled(q, meta.qtyPrecision),
      ];
      this.publish(stream, {
        symbol,
        firstUpdateId: pending.firstU,
        finalUpdateId: pending.lastU,
        prevFinalUpdateId: pu,
        bids: this.sortedLevels(pending.bids, 'desc').map(fmt),
        asks: this.sortedLevels(pending.asks, 'asc').map(fmt),
        ts: pending.ts,
      });
    }
    this.pendingDiffBySymbol.clear();
  }

  private sortedLevels(levels: Map<string, string>, dir: 'asc' | 'desc'): [string, string][] {
    const arr = [...levels.entries()];
    arr.sort(([a], [b]) => {
      const ba = BigInt(a);
      const bb = BigInt(b);
      if (ba === bb) return 0;
      const cmp = ba < bb ? -1 : 1;
      return dir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }

  // ---- broadcast ----

  protected publish(stream: string, data: unknown): void {
    const subs = this.clientsByStream.get(stream);
    if (!subs || subs.size === 0) return;
    const payload = JSON.stringify({ stream, data });
    for (const client of subs) {
      this.sendRaw(client, payload);
    }
  }

  /**
   * 백프레셔 가드 송신: 소켓 송신버퍼가 DROP 초과면 이 메시지만 드롭(느린 클라이언트가
   * 프로세스 메모리를 무한 흡수하는 것 방지 — 유실은 스트림 시퀀스 필드로 감지 가능),
   * KILL 초과면 연결 종료.
   */
  private sendRaw(client: WebSocket, payload: string): void {
    if (client.readyState !== WS_OPEN) return;
    if (client.bufferedAmount >= BP_KILL_BYTES) {
      this.logger.warn(`ws backpressure kill: bufferedAmount=${client.bufferedAmount}`);
      client.terminate();
      return;
    }
    if (client.bufferedAmount >= BP_DROP_BYTES) {
      if (!this.bpWarned.has(client)) {
        this.bpWarned.add(client);
        this.logger.warn(`ws backpressure drop: bufferedAmount=${client.bufferedAmount}`);
      }
      return;
    }
    client.send(payload);
  }

  protected fanoutTrade(event: TradeEvent): void {
    if (event.market !== this.market) return;
    const lower = event.symbol.toLowerCase();
    const meta = this.tickerStats.metaOf(event.market, event.symbol);
    if (!meta) return;

    const tradeStream = `${lower}@trade`;
    if (this.clientsByStream.get(tradeStream)?.size) {
      this.publish(tradeStream, [
        {
          id: event.tradeId,
          symbol: event.symbol,
          price: event.price.toFixed(meta.pricePrecision),
          qty: event.qty.toFixed(meta.qtyPrecision),
          side: event.takerSide,
          ts: event.ts,
        },
      ]);
    }

    const tickerStream = `${lower}@ticker`;
    if (this.clientsByStream.get(tickerStream)?.size) {
      const snap = this.tickerStats.snapshotOne(event.market, event.symbol);
      if (snap) this.publish(tickerStream, snap);
    }
  }

  protected broadcastTickerArr(): void {
    const subs = this.clientsByStream.get(ALL_TICKERS_STREAM);
    if (!subs || subs.size === 0) return;
    this.publish(ALL_TICKERS_STREAM, this.tickerStats.snapshotAll(this.market));
  }

  protected formattedDepth(symbol: string): {
    lastUpdateId: number;
    bids: [string, string][];
    asks: [string, string][];
  } {
    const meta = this.tickerStats.metaOf(this.market, symbol);
    const raw = this.obCache.getDepth(this.market, symbol, DEPTH_LEVELS);
    if (!meta) return { lastUpdateId: raw.lastUpdateId, bids: [], asks: [] };
    const fmt = ([p, q]: [string, string]): [string, string] => [
      fmtScaled(p, meta.pricePrecision),
      fmtScaled(q, meta.qtyPrecision),
    ];
    return {
      lastUpdateId: raw.lastUpdateId,
      bids: raw.bids.map(fmt),
      asks: raw.asks.map(fmt),
    };
  }

  protected send(client: WebSocket, payload: unknown): void {
    this.sendRaw(client, JSON.stringify(payload));
  }
}
