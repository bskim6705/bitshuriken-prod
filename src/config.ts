import 'dotenv/config';
import type { Market } from './core/types';

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

export const config = {
  // Lazy: pure-backtest entry points (backtest-cli) never touch the live exchange, so
  // req() must fire only when a live path actually reads the field — not at import time.
  api: {
    get spot() {
      return req('SPOT_API');
    },
    get futures() {
      return req('FUTURES_API');
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
  agent: {
    labelPrefix: process.env.AGENT_LABEL_PREFIX ?? 'agent',
    capitalUsdt: num('AGENT_CAPITAL_USDT', 1_000_000),
    recvWindowMs: num('API_KEY_RECV_WINDOW_MS', 5000),
  },
  control: {
    host: process.env.CONTROL_HOST ?? '127.0.0.1',
    port: num('CONTROL_PORT', 5120),
    url: process.env.AGENTD_URL ?? 'http://127.0.0.1:5120',
  },
  // admin secret for ticker listing/activation, and the prod bots dir we spawn mirror
  // processes from (live book for live agents). 봇은 이 포크에 없는 별개 서비스라 유저 표면으로
  // 붙는다 (feedback-023/025) — mirror는 BOTS_DIR에 그 레포가 설치돼 있어야 동작.
  adminSecret: process.env.ADMIN_API_SECRET ?? '',
  botsDir: process.env.BOTS_DIR ?? '../bitshuriken-prod-bots',
  dataDir: process.env.DATA_DIR ?? './data',
  live: {
    klineInterval: process.env.KLINE_INTERVAL ?? '1m',
    barPollMs: num('BAR_POLL_MS', 2000),
  },
  sim: {
    feeBps: num('SIM_FEE_BPS', 10),
    slippageBps: num('SIM_SLIPPAGE_BPS', 2),
    latencyBars: num('SIM_LATENCY_BARS', 1),
  },
};

/** base URL for a given local market app. */
export function apiBase(market: Market): string {
  return market === 'SPOT' ? config.api.spot : config.api.futures;
}
