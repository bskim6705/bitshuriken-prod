import { BaseWsClient, getWsSingleton } from "./base-client";

export type UserStreamName =
  | "executionReport"
  | "outboundAccountPosition"
  | "listStatus"
  | "listenKeyExpired";

type Listener = (data: unknown) => void;

/** 새 listenKey를 발급하는 비동기 함수 (각 게이트웨이의 user-data-stream POST). */
type ListenKeyProvider = () => Promise<string>;

interface InboundMsg {
  stream?: string;
  data?: unknown;
}

const DEFAULT_PATH = "/ws/user";
const LISTEN_KEY_EXPIRED = "listenKeyExpired";
const CLOSE_UNAUTHORIZED = 4401;

/**
 * User-stream 클라이언트 (쿠키 인증). SUBSCRIBE 프로토콜 없음 — 서버가 {stream, data}를 push.
 * connect()를 명시적으로 호출할 때만 연결 (로그인 상태에서 훅이 호출).
 * S = 게이트웨이별 스트림 이름 유니온 (spot /ws/user, futures /ws/fuser).
 *
 * listenKeyProvider가 설정되면 ?listenKey=로 연결하고, 만료 통지(listenKeyExpired) 시
 * 영구 정지 대신 새 listenKey를 발급해 재연결한다.
 */
class UserWsClient<S extends string = UserStreamName> extends BaseWsClient {
  private wanted = false;
  private readonly listeners = new Map<S, Set<Listener>>();
  private readonly openCbs = new Set<() => void>();
  private listenKeyProvider: ListenKeyProvider | null = null;
  private listenKey: string | null = null;
  // 만료 통지 → 재발급/재연결이 진행 중이면 4401 close가 스트림을 죽이지 않게 한다.
  private recreating = false;

  constructor(url: string) {
    super(url, "ws/user");
  }

  /** listenKey 인증으로 전환. 한 번만 설정(싱글톤 공유). */
  setListenKeyProvider(provider: ListenKeyProvider): void {
    if (this.listenKeyProvider) return;
    this.listenKeyProvider = provider;
  }

  connect(): void {
    this.wanted = true;
    if (this.isSocketActive()) return;
    if (this.listenKeyProvider && !this.listenKey) {
      void this.acquireAndOpen();
      return;
    }
    this.openSocket();
  }

  disconnect(): void {
    this.wanted = false;
    this.recreating = false;
    this.clearReconnect();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  on(stream: S, cb: Listener): () => void {
    let set = this.listeners.get(stream);
    if (!set) {
      set = new Set();
      this.listeners.set(stream, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.listeners.delete(stream);
    };
  }

  /** 모든 open(첫 연결 + 재연결) 시 호출되는 콜백 등록. 반환값은 해제 함수. */
  onOpen(cb: () => void): () => void {
    this.openCbs.add(cb);
    return () => this.openCbs.delete(cb);
  }

  protected connectUrl(): string {
    if (!this.listenKey) return this.url;
    const sep = this.url.includes("?") ? "&" : "?";
    return `${this.url}${sep}listenKey=${encodeURIComponent(this.listenKey)}`;
  }

  protected handleOpen(): void {
    this.recreating = false;
    for (const cb of this.openCbs) cb();
  }

  protected handleClose(ev: CloseEvent): void {
    if (ev.code === CLOSE_UNAUTHORIZED) {
      // 만료 재발급이 진행 중이면 죽이지 않는다 — acquireAndOpen이 재연결을 끝낸다.
      if (this.recreating) {
        this.socket = null;
        return;
      }
      // 재발급 수단이 있으면 시도, 없으면(쿠키 전용) 영구 정지.
      if (this.listenKeyProvider && this.wanted) {
        this.socket = null;
        this.recreateStream();
        return;
      }
      this.logError("unauthorized, closing");
      this.wanted = false;
      this.socket = null;
      return;
    }
    this.scheduleReconnect();
  }

  protected shouldReconnect(): boolean {
    return this.wanted;
  }

  protected handleMessage(parsed: unknown): void {
    const msg = parsed as InboundMsg;
    if (msg.stream === undefined || msg.data === undefined) return;
    // 만료 통지는 close 직전에 도착 — 새 listenKey로 재연결을 선제 시작.
    if (msg.stream === LISTEN_KEY_EXPIRED) this.recreateStream();
    const set = this.listeners.get(msg.stream as S);
    if (!set) return;
    for (const cb of set) cb(msg.data);
  }

  /** 새 listenKey를 발급하고 그 키로 소켓을 연다. */
  private async acquireAndOpen(): Promise<void> {
    if (!this.listenKeyProvider) {
      this.openSocket();
      return;
    }
    try {
      this.listenKey = await this.listenKeyProvider();
    } catch (err) {
      this.logError("failed to acquire listenKey", err);
      this.recreating = false;
      this.scheduleReconnect();
      return;
    }
    if (!this.wanted) return; // 발급 중 disconnect됨
    this.openSocket();
  }

  /** 만료/취소 후 새 listenKey로 재연결 (재진입 방지). */
  private recreateStream(): void {
    if (!this.listenKeyProvider || !this.wanted || this.recreating) return;
    this.recreating = true;
    this.clearReconnect();
    this.listenKey = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    void this.acquireAndOpen();
  }
}

// path별 싱글톤 (spot /ws/user, futures /ws/fuser)
const singletons = new Map<string, UserWsClient<string>>();

export function getUserWsClient<S extends string = UserStreamName>(
  path: string = DEFAULT_PATH,
): UserWsClient<S> {
  return getWsSingleton(
    singletons,
    path,
    (url) => new UserWsClient<string>(url),
    "user ws client is client-side only",
  ) as UserWsClient<S>;
}
