import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { SESSION_COOKIE_NAME } from '@app/core-domain/auth/session.config';
import { ListenKeyServiceBase } from './listen-key.base';

const WS_OPEN = 1;
const CLOSE_UNAUTHORIZED = 4401;
const PING_INTERVAL_MS = 30_000;

interface AuthResult {
  userId: string;
  listenKey?: string;
}

/** 유저 이벤트 소스 — UserStreamService/FuturesUserEventsService가 구조적으로 만족. */
export interface UserEventSource<TEvent> {
  onEvent(listener: (userId: string, event: TEvent) => void): () => void;
}

/**
 * User data stream 게이트웨이 공통 구현. 인증: bs_session 쿠키(+Origin 검사) 또는 ?listenKey=.
 * 이벤트 소스에 단일 리스너 1개를 등록해 userId별 소켓으로 fanout.
 */
export abstract class WsUserGatewayBase<TEvent>
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  private readonly userBySocket = new WeakMap<WebSocket, string>();
  private readonly listenKeyBySocket = new WeakMap<WebSocket, string>();
  private readonly aliveBySocket = new WeakMap<WebSocket, boolean>();
  private readonly socketsByUser = new Map<string, Set<WebSocket>>();
  private readonly socketsByListenKey = new Map<string, Set<WebSocket>>();

  private readonly corsOrigins: Set<string>;
  private pingTimer: NodeJS.Timeout | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private unsubscribeRevoked: (() => void) | null = null;

  protected abstract readonly jwt: JwtService;
  protected abstract readonly events: UserEventSource<TEvent>;
  protected abstract readonly listenKeys: ListenKeyServiceBase;

  constructor() {
    this.corsOrigins = new Set(
      (process.env.CORS_ORIGINS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  onModuleInit(): void {
    this.unsubscribeEvents = this.events.onEvent((userId, event) => {
      this.fanout(userId, event);
    });
    this.unsubscribeRevoked = this.listenKeys.onRevoked((listenKey) => {
      this.closeByListenKey(listenKey);
    });
    this.pingTimer = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    this.unsubscribeEvents?.();
    this.unsubscribeRevoked?.();
    if (this.pingTimer) clearInterval(this.pingTimer);
  }

  handleConnection(client: WebSocket, request: IncomingMessage): void {
    const auth = this.authenticate(request);
    if (!auth) {
      client.close(CLOSE_UNAUTHORIZED, 'Unauthorized');
      return;
    }

    this.userBySocket.set(client, auth.userId);
    this.addToIndex(this.socketsByUser, auth.userId, client);
    if (auth.listenKey) {
      this.listenKeyBySocket.set(client, auth.listenKey);
      this.addToIndex(this.socketsByListenKey, auth.listenKey, client);
    }

    this.aliveBySocket.set(client, true);
    client.on('pong', () => this.aliveBySocket.set(client, true));
  }

  handleDisconnect(client: WebSocket): void {
    const userId = this.userBySocket.get(client);
    if (userId) this.removeFromIndex(this.socketsByUser, userId, client);
    const listenKey = this.listenKeyBySocket.get(client);
    if (listenKey) this.removeFromIndex(this.socketsByListenKey, listenKey, client);
    this.userBySocket.delete(client);
    this.listenKeyBySocket.delete(client);
    this.aliveBySocket.delete(client);
  }

  // ---- auth ----

  /** listenKey 우선(Origin 검사 생략 — 키 소지가 자격), 없으면 쿠키 + Origin 검사. URL 로깅 금지. */
  private authenticate(request: IncomingMessage): AuthResult | null {
    const listenKey = extractListenKey(request.url);
    if (listenKey) {
      const userId = this.listenKeys.resolve(listenKey);
      if (!userId) return null;
      return { userId, listenKey };
    }

    const origin = request.headers.origin;
    if (!origin || !this.corsOrigins.has(origin)) return null;

    const token = parseCookieValue(request.headers.cookie, SESSION_COOKIE_NAME);
    if (!token) return null;
    try {
      const payload = this.jwt.verify<{ sub: string }>(token);
      return { userId: payload.sub };
    } catch {
      return null;
    }
  }

  // ---- fanout / lifecycle ----

  private fanout(userId: string, event: TEvent): void {
    const sockets = this.socketsByUser.get(userId);
    if (!sockets || sockets.size === 0) return;
    const payload = JSON.stringify(event);
    for (const client of sockets) {
      if (client.readyState === WS_OPEN) client.send(payload);
    }
  }

  /** 취소/만료 sweep 양쪽이 여기로 모인다(ListenKeyServiceBase가 REVOKED 발화). */
  private closeByListenKey(listenKey: string): void {
    const sockets = this.socketsByListenKey.get(listenKey);
    if (!sockets) return;
    // in-band 통지를 close 직전에 보내 FE가 영구 정지 대신 재발급하도록 한다.
    const notice = JSON.stringify({
      stream: 'listenKeyExpired',
      data: { listenKey, ts: Date.now() },
    });
    for (const client of [...sockets]) {
      if (client.readyState === WS_OPEN) client.send(notice);
      client.close(CLOSE_UNAUTHORIZED, 'listenKey revoked');
    }
  }

  private pingAll(): void {
    for (const sockets of this.socketsByUser.values()) {
      for (const client of [...sockets]) {
        if (this.aliveBySocket.get(client) === false) {
          client.terminate(); // pong 미응답 — handleDisconnect가 인덱스 정리
          continue;
        }
        this.aliveBySocket.set(client, false);
        if (client.readyState === WS_OPEN) client.ping();
      }
    }
  }

  private addToIndex(index: Map<string, Set<WebSocket>>, key: string, client: WebSocket): void {
    let set = index.get(key);
    if (!set) {
      set = new Set();
      index.set(key, set);
    }
    set.add(client);
  }

  private removeFromIndex(
    index: Map<string, Set<WebSocket>>,
    key: string,
    client: WebSocket,
  ): void {
    const set = index.get(key);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) index.delete(key);
  }
}

function extractListenKey(url: string | undefined): string | null {
  if (!url) return null;
  const q = url.indexOf('?');
  if (q < 0) return null;
  return new URLSearchParams(url.slice(q + 1)).get('listenKey');
}

function parseCookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}
