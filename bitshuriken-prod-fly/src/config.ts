import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
function num(name: string, dflt: number): number {
  const v = process.env[name];
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name} must be a number, got "${v}"`);
  return n;
}

/** Lazy getters: build/train/backtest never touch the live exchange, so req() fires only on live paths. */
export const config = {
  api: {
    get spot() {
      return req('SPOT_API');
    },
    get portal() {
      return req('PORTAL_API');
    },
  },
  master: {
    get email() {
      return req('MASTER_EMAIL');
    },
    get password() {
      return req('MASTER_PASSWORD');
    },
  },
  capitalUsdt: num('FLY_CAPITAL_USDT', 100_000),
  recvWindowMs: num('API_KEY_RECV_WINDOW_MS', 15_000),
  interval: process.env.FLY_INTERVAL ?? '1m',
  barPollMs: num('BAR_POLL_MS', 2000),
  port: num('FLY_PORT', 5130),
  /** 대시보드·JSON API 바인드 주소. 컨테이너/맥미니 LAN 관전은 0.0.0.0 (인증 없음 — 신뢰망에서만). */
  host: process.env.FLY_HOST ?? '127.0.0.1',
  internalToken: process.env.FLY_INTERNAL_TOKEN ?? '',
  sim: { feeBps: num('SIM_FEE_BPS', 10), slippageBps: num('SIM_SLIPPAGE_BPS', 2) },
  /** 초파리 계정의 실제 테이커 수수료(bps) — 진화 적합도·lob 시뮬에 쓴다. 티어 변경 시 함께 바꾼다. */
  takerFeeBps: num('FLY_TAKER_FEE_BPS', 10),
  dataDir: process.env.DATA_DIR ?? './data',
};
