// 송신 rate-limit: baseUrl별 weight 토큰버킷 + Retry-After pause.
// 서버가 주는 X-MBX-USED-WEIGHT-1M로 사용량을 스냅(서버 authoritative)해 429를 선제 회피한다.
//
// 항상 적용: 429 Retry-After pause(실제 429에만 반응).
// 선제 throttle(예산 초과 시 윈도우 리셋까지 대기)은 NEXT_PUBLIC_RATE_LIMIT_ENABLED==="true"일 때만.

const PROACTIVE = process.env.NEXT_PUBLIC_RATE_LIMIT_ENABLED === "true";
const MINUTE_MS = 60_000;
const MAX_WAIT_MS = 10_000; // 이 이상 기다리지 않고 통과(UI hang 방지)
const SAFETY = 0.9; // 서버 예산의 90%에서 선제 대기
const DEFAULT_BUDGET = 2000; // 클라 측 분당 weight 예산(서버 6000/2400보다 보수적; 헤더로 스냅)
const POLL_MS = 200;

interface BaseState {
  windowId: number;
  used: number; // 로컬 추정, 서버 헤더로 상향 스냅
  pausedUntil: number; // epoch ms
}

const states = new Map<string, BaseState>();

function stateFor(baseUrl: string): BaseState {
  const win = Math.floor(Date.now() / MINUTE_MS);
  let s = states.get(baseUrl);
  if (!s) {
    s = { windowId: win, used: 0, pausedUntil: 0 };
    states.set(baseUrl, s);
  }
  if (s.windowId !== win) {
    s.windowId = win;
    s.used = 0;
  }
  return s;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 엔드포인트별 weight (서버 @Weight 스킴 미러). 미지정 GET/뮤테이션 = 1. */
export function weightOf(method: string, path: string): number {
  if (method !== "GET") return 1;
  if (path.includes("/exchange-info")) return 20;
  if (path.includes("/tickers")) return 80;
  if (path.includes("/depth")) return 5;
  if (path.includes("/klines")) return 2;
  return 1;
}

/** 요청 전 호출 — Retry-After pause를 항상 존중하고, 선제 throttle은 PROACTIVE일 때만. */
export async function acquire(baseUrl: string, weight: number): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;

  // 1) Retry-After pause (항상)
  for (let s = stateFor(baseUrl); s.pausedUntil > Date.now() && Date.now() < deadline; s = stateFor(baseUrl)) {
    await sleep(Math.min(s.pausedUntil - Date.now(), POLL_MS));
  }

  // 2) 선제 weight throttle (게이트)
  if (PROACTIVE) {
    let s = stateFor(baseUrl);
    while (s.used + weight > DEFAULT_BUDGET * SAFETY && Date.now() < deadline) {
      const msToNextWindow = MINUTE_MS - (Date.now() % MINUTE_MS);
      await sleep(Math.min(msToNextWindow, POLL_MS, Math.max(0, deadline - Date.now())));
      s = stateFor(baseUrl);
    }
  }

  stateFor(baseUrl).used += weight;
}

/** 응답 후 호출 — 서버 used-weight 헤더로 사용량을 상향 스냅. */
export function release(baseUrl: string, headers: Headers | null): void {
  if (!headers) return;
  const used = Number(headers.get("X-MBX-USED-WEIGHT-1M"));
  if (Number.isFinite(used)) {
    const s = stateFor(baseUrl);
    s.used = Math.max(s.used, used);
  }
}

/** 429/418 수신 시 호출 — Retry-After 동안 해당 baseUrl을 pause. */
export function pauseFor(baseUrl: string, retryAfterSec: number): void {
  stateFor(baseUrl).pausedUntil = Date.now() + Math.max(0, retryAfterSec) * 1000;
}
