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
const THROTTLE_MS = 1000;
const PING_INTERVAL_MS = 30_000;
const DEPTH_LEVELS = 50;
const WS_OPEN = 1;

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
  private pingTimer: NodeJS.Timeout | null = null;
  private unsubscribeTrade: (() => void) | null = null;

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
    this.pingTimer = setInterval(() => this.heartbeat(), PING_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.unsubscribeTrade?.();
    this.onGatewayDestroy();
    if (this.secondTimer) clearInterval(this.secondTimer);
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

  // ---- broadcast ----

  protected publish(stream: string, data: unknown): void {
    const subs = this.clientsByStream.get(stream);
    if (!subs || subs.size === 0) return;
    const payload = JSON.stringify({ stream, data });
    for (const client of subs) {
      if (client.readyState === WS_OPEN) client.send(payload);
    }
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
    if (client.readyState === WS_OPEN) client.send(JSON.stringify(payload));
  }
}
