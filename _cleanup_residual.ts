// THROWAWAY (deleted after use): cancel residual loadtest open orders through the engine.
// Not part of the harness — re-instantiates the deterministic loadtest clients and calls the
// public DELETE /spot/trading/open-orders surface (engine-routed, no DB writes).
import { config } from './src/config';
import { LocalExchangeClient } from './src/exchange';

const N = Number(process.env.LT_ACCOUNTS ?? 16);
const SYMS = (process.env.LT_SYMBOLS ?? 'BTCUSDT,ETHUSDT').split(',').map((s) => s.trim());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const clients: LocalExchangeClient[] = [];
  for (let i = 0; i < N; i++) {
    const c = new LocalExchangeClient(`loadtest-${i}`);
    await c.ensureAccount(`loadtest-${i}@bots.local`, config.accounts.password);
    await c.ensureApiKey();
    if (config.adminSecret) await c.ensureRateLimitExempt(config.adminSecret).catch(() => {});
    clients.push(c);
  }

  let remaining = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    for (const c of clients) for (const s of SYMS) await c.cancelAllSpot(s).catch(() => {});
    await sleep(700);
    remaining = 0;
    for (const c of clients)
      for (const s of SYMS) {
        try {
          remaining += (await c.openOrders('SPOT', s)).length;
        } catch {
          /* ignore */
        }
      }
    if (remaining === 0) break;
  }
  console.log(`RESIDUAL_REMAINING=${remaining}`);
  process.exit(remaining === 0 ? 0 : 2);
}
main().catch((e) => {
  console.error('cleanup error', e);
  process.exit(1);
});
