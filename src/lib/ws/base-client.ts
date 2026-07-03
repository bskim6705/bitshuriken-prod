const MAX_RECONNECT_DELAY_MS = 15000;

export function buildWsUrl(path: string): string {
  // futures 게이트웨이(/ws/fmarket, /ws/fuser)는 별도 BE 앱(프로세스)에 산다
  const isFutures = path.startsWith("/ws/f");
  const base = isFutures ? process.env.NEXT_PUBLIC_FUTURES_API_URL : process.env.NEXT_PUBLIC_API_URL;
  if (!base) {
    throw new Error(isFutures ? "NEXT_PUBLIC_FUTURES_API_URL is required" : "NEXT_PUBLIC_API_URL is required");
  }
  return `${base.replace(/^http/, "ws")}${path}`;
}

/**
 * WS 공통 베이스 — 소켓 수명주기, 지수 백오프 재연결, JSON 파싱.
 * 프로토콜(구독 방식/인증/메시지 라우팅)은 서브클래스가 구현.
 */
export abstract class BaseWsClient {
  protected socket: WebSocket | null = null;
  protected readonly url: string;
  private readonly logTag: string;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string, logTag: string) {
    this.url = url;
    this.logTag = logTag;
  }

  protected isSocketActive(): boolean {
    return this.socket !== null && this.socket.readyState <= WebSocket.OPEN;
  }

  /** 연결 시 사용할 URL. 기본은 고정 base — 서브클래스가 동적 쿼리(listenKey 등)를 붙인다. */
  protected connectUrl(): string {
    return this.url;
  }

  protected openSocket(): void {
    const ws = new WebSocket(this.connectUrl());
    this.socket = ws;
    ws.onopen = () => {
      if (this.socket !== ws) return; // 교체된 소켓
      this.reconnectAttempts = 0;
      this.handleOpen();
    };
    ws.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(ev.data));
      } catch (err) {
        console.error(`[${this.logTag}] bad message`, err);
        return;
      }
      this.handleMessage(parsed);
    };
    ws.onclose = (ev) => {
      if (this.socket !== ws) return; // 교체/해제된 소켓
      this.handleClose(ev);
    };
    ws.onerror = (err) => {
      console.error(`[${this.logTag}] socket error`, err);
    };
  }

  protected scheduleReconnect(): void {
    this.socket = null;
    if (!this.shouldReconnect()) return;
    // 지터 — N개 클라이언트가 서버 blip 후 동시 재연결(thundering herd)하지 않게 50~100%로 분산.
    const base = Math.min(1000 * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY_MS);
    const delay = base * (0.5 + Math.random() * 0.5);
    this.reconnectAttempts += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.shouldReconnect()) this.openSocket();
    }, delay);
  }

  protected clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
  }

  protected sendJson(msg: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    }
  }

  protected logError(message: string, ...args: unknown[]): void {
    console.error(`[${this.logTag}] ${message}`, ...args);
  }

  protected abstract handleOpen(): void;
  protected abstract handleMessage(parsed: unknown): void;
  protected abstract handleClose(ev: CloseEvent): void;
  /** 소켓 유실 시 재연결 시도 여부 (market: 활성 구독 존재, user: connect 유지 상태). */
  protected abstract shouldReconnect(): boolean;
}

/** path별 싱글톤 getter. SSR에서는 인스턴스화 금지. */
export function getWsSingleton<T>(
  cache: Map<string, T>,
  path: string,
  create: (url: string) => T,
  ssrError: string,
): T {
  if (typeof window === "undefined") {
    // SSR safety — never instantiate on server
    throw new Error(ssrError);
  }
  let client = cache.get(path);
  if (!client) {
    client = create(buildWsUrl(path));
    cache.set(path, client);
  }
  return client;
}
