import { BaseWsClient, getWsSingleton } from "./base-client";

type Listener = (data: unknown) => void;

interface Subscription {
  stream: string;
  listeners: Set<Listener>;
  lastData: unknown;
}

interface OutboundMsg {
  method: "SUBSCRIBE" | "UNSUBSCRIBE";
  streams: string[];
  id: number;
}

interface InboundMsg {
  stream?: string;
  data?: unknown;
  result?: unknown;
  error?: string;
  streams?: string[];
  id?: number;
}

const DEFAULT_PATH = "/ws/market";

/** Market 스트림 클라이언트 — SUBSCRIBE/UNSUBSCRIBE 프로토콜, 구독 존재 시 자동 연결. */
class WsClient extends BaseWsClient {
  private readonly subs = new Map<string, Subscription>();
  private msgId = 0;
  private hasConnectedOnce = false;
  private readonly reconnectCbs = new Set<() => void>();
  private readonly streamErrorCbs = new Set<(streams: string[]) => void>();

  constructor(url: string) {
    super(url, "ws");
  }

  /** 첫 연결 이후의 모든 재연결 성공 시 호출되는 콜백 등록. 반환값은 해제 함수. */
  onReconnect(cb: () => void): () => void {
    this.reconnectCbs.add(cb);
    return () => this.reconnectCbs.delete(cb);
  }

  /** 서버가 구독을 거부한 스트림 이름들로 호출되는 콜백 등록. 반환값은 해제 함수. */
  onStreamError(cb: (streams: string[]) => void): () => void {
    this.streamErrorCbs.add(cb);
    return () => this.streamErrorCbs.delete(cb);
  }

  subscribe(stream: string, listener: Listener): () => void {
    let sub = this.subs.get(stream);
    const isNew = !sub;
    if (!sub) {
      sub = { stream, listeners: new Set(), lastData: undefined };
      this.subs.set(stream, sub);
    } else if (sub.lastData !== undefined) {
      // late subscriber — replay last known data
      listener(sub.lastData);
    }
    sub.listeners.add(listener);

    if (!this.isSocketActive()) this.openSocket();
    if (isNew) this.sendSubscribe([stream]);

    return () => this.cleanup(stream, listener);
  }

  private cleanup(stream: string, listener: Listener): void {
    const sub = this.subs.get(stream);
    if (!sub) return;
    sub.listeners.delete(listener);
    if (sub.listeners.size === 0) {
      this.subs.delete(stream);
      this.sendUnsubscribe([stream]);
    }
  }

  protected handleOpen(): void {
    const active = [...this.subs.keys()];
    if (active.length) this.sendSubscribe(active);
    if (this.hasConnectedOnce) {
      for (const cb of this.reconnectCbs) cb();
    }
    this.hasConnectedOnce = true;
  }

  protected handleClose(): void {
    this.scheduleReconnect();
  }

  protected shouldReconnect(): boolean {
    return this.subs.size > 0;
  }

  private sendSubscribe(streams: string[]): void {
    this.send({ method: "SUBSCRIBE", streams, id: ++this.msgId });
  }

  private sendUnsubscribe(streams: string[]): void {
    this.send({ method: "UNSUBSCRIBE", streams, id: ++this.msgId });
  }

  private send(msg: OutboundMsg): void {
    this.sendJson(msg);
    // not OPEN이면 drop — 다음 open 때 활성 스트림 전체 재구독
  }

  protected handleMessage(parsed: unknown): void {
    const msg = parsed as InboundMsg;
    if (msg.error) {
      // 거부된 스트림은 리스너에 통지 후 구독 해제 — 재연결 시 재시도하지 않음
      if (msg.streams) {
        for (const cb of this.streamErrorCbs) cb(msg.streams);
        for (const stream of msg.streams) this.subs.delete(stream);
      }
      this.logError("server error", msg.error, msg.streams ?? []);
      return;
    }
    if (msg.stream !== undefined && msg.data !== undefined) {
      const sub = this.subs.get(msg.stream);
      if (!sub) return;
      sub.lastData = msg.data;
      for (const listener of sub.listeners) listener(msg.data);
    }
  }
}

// path별 싱글톤 (spot /ws/market, futures /ws/fmarket)
const singletons = new Map<string, WsClient>();

export function getWsClient(path: string = DEFAULT_PATH): WsClient {
  return getWsSingleton(singletons, path, (url) => new WsClient(url), "ws client is client-side only");
}
