import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { LocalExchangeClient, type ApiKeyPair } from './exchange';
import { makeLogger } from './log';
import type { Market, SymbolSpec } from './types';

/**
 * Ghost-order sweeper: cancels every resting order of every bot account, mirrored or not.
 * A shutdown under BE backlog can time out cancels silently and leave phantom quotes on
 * symbols no maker serves anymore — a real exchange never keeps those. Trades only through
 * the user surface (feedback-025): logs into each deterministic bot account and cancels
 * its own orders. Safe to run anytime; no-op for accounts with nothing resting.
 *
 * Usage: npm run sweep
 */
const log = makeLogger('sweep');
const KEY_STORE = path.join(process.cwd(), '.bot-keys.json');

const accountEmail = (role: 'maker' | 'taker', spec: SymbolSpec): string =>
  `${role}-${spec.market === 'FUTURES' ? 'f-' : ''}${spec.symbol.toLowerCase()}@bots.local`;

async function main(): Promise<void> {
  const keys = ((): Record<string, ApiKeyPair> => {
    try {
      return JSON.parse(fs.readFileSync(KEY_STORE, 'utf8')) as Record<string, ApiKeyPair>;
    } catch {
      return {};
    }
  })();

  const probe = new LocalExchangeClient('sweep');
  const specs: SymbolSpec[] = [];
  for (const market of ['SPOT', 'FUTURES'] as Market[]) {
    specs.push(...(await probe.exchangeInfo(market).catch(() => [] as SymbolSpec[])));
  }

  let cancelled = 0;
  let ghosts = 0;
  for (const spec of specs) {
    for (const role of ['maker', 'taker'] as const) {
      const email = accountEmail(role, spec);
      const client = new LocalExchangeClient(`${role}:${spec.market}:${spec.symbol}`);
      try {
        await client.ensureAccount(email, config.accounts.password);
      } catch {
        continue; // account never existed — nothing to sweep
      }
      const cached = keys[email];
      if (cached) client.setApiKey(cached);
      if (!cached || !(await client.keyWorks().catch(() => false))) {
        await client.ensureApiKey();
        keys[email] = client.getApiKey()!;
      }
      const open = await client.openOrders(spec.market, spec.symbol).catch(() => []);
      if (open.length === 0) continue;
      log.info(`${spec.market}:${spec.symbol} ${role}: cancelling ${open.length} resting orders`);
      await Promise.allSettled(open.map((o) => client.cancel(spec.market, o.id)));
      // cancels are async (BE→engine→consumer) — give the pipeline a moment before verifying
      await new Promise((r) => setTimeout(r, 3000));
      const left = await client.openOrders(spec.market, spec.symbol).catch(() => []);
      cancelled += open.length - left.length;
      ghosts += left.length;
      if (left.length > 0) log.warn(`${spec.market}:${spec.symbol} ${role}: ${left.length} STILL open`);
    }
  }
  fs.writeFileSync(KEY_STORE, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  if (ghosts > 0) {
    log.err(`sweep incomplete: ${cancelled} cancelled, ${ghosts} still resting`);
    process.exit(1);
  }
  log.ok(`sweep clean: ${cancelled} orders cancelled`);
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
