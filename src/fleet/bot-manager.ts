import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { config } from '../config';
import { makeLogger } from '../core/logger';
import { AdminClient } from '../core/admin';
import { fetchSpec } from '../core/binance';
import type { Market } from '../core/types';

interface Mirror {
  symbol: string;
  market: Market;
  child: ChildProcess;
  pid: number;
  startedAt: number;
}

export interface MirrorStatus {
  symbol: string;
  market: Market;
  pid: number;
  uptimeMs: number;
}

const key = (market: Market, symbol: string): string => `${market}:${symbol}`;

/**
 * Provisions live liquidity for agents: flips a seeded ticker to TRADING and spawns a
 * prod bots mirror process per symbol (one symbol per child) so a live agent has a
 * Binance-faithful book to trade against. Stop sends SIGINT (bots cancels its book).
 * The bots repo is a SEPARATE service not in this fork (feedback-023/025) — mirror spawn
 * needs it installed at BOTS_DIR; ticker activation (ensureTradable) works without it.
 */
export class BotManager {
  private readonly admin = new AdminClient();
  private readonly mirrors = new Map<string, Mirror>();
  private readonly inflight = new Map<string, Promise<MirrorStatus>>();
  private readonly log = makeLogger('mirror');

  /** make `symbol` tradable. Seeded symbols (engine lane exists) flip to TRADING at runtime;
   *  a brand-new symbol is created but needs a match-engine restart before it can trade. */
  async ensureTradable(symbol: string, market: Market = 'SPOT'): Promise<Record<string, unknown>> {
    const tickers = await this.admin.listTickers();
    const t = tickers.find((x) => x.symbol === symbol && x.marketType === market);
    if (t) {
      if (t.status === 'TRADING') return { symbol, market, status: 'TRADING', action: 'already-trading' };
      await this.admin.setTickerStatus(market, symbol, 'TRADING');
      this.log.ok(`activated ${symbol} (${t.status} → TRADING)`);
      return { symbol, market, status: 'TRADING', action: 'activated' };
    }
    const spec = await fetchSpec(market, symbol);
    const created = await this.admin.createTicker({
      market,
      baseAsset: spec.baseAsset,
      quoteAsset: spec.quoteAsset,
      symbol,
      pricePrecision: spec.pricePrecision,
      qtyPrecision: spec.qtyPrecision,
      minNotional: String(spec.minNotional),
    });
    this.log.warn(`created new ticker ${symbol} (status ${created.status})`);
    return {
      symbol,
      market,
      status: created.status,
      action: 'created',
      warning: 'new symbol: add it to the match engine tickers.json and restart the engine before it can trade',
    };
  }

  /** start a Binance mirror for `symbol` (activates the ticker first when possible).
   *  Concurrent calls for the same symbol share one in-flight launch. */
  async startMirror(symbol: string, market: Market = 'SPOT'): Promise<MirrorStatus> {
    const k = key(market, symbol);
    const existing = this.mirrors.get(k);
    if (existing) return this.toStatus(existing);
    const pending = this.inflight.get(k);
    if (pending) return pending;
    const p = this.spawnMirror(k, symbol, market).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    return p;
  }

  private async spawnMirror(k: string, symbol: string, market: Market): Promise<MirrorStatus> {
    if (config.adminSecret) await this.ensureTradable(symbol, market);
    else this.log.warn(`no ADMIN_API_SECRET — assuming ${symbol} is already TRADING`);

    const botsDir = resolve(process.cwd(), config.botsDir);
    const tsx = resolve(botsDir, 'node_modules', '.bin', 'tsx');
    const child = spawn(tsx, ['src/run.ts'], {
      cwd: botsDir,
      env: { ...process.env, SPOT_SYMBOLS: market === 'SPOT' ? symbol : '', FUTURES_SYMBOLS: market === 'FUTURES' ? symbol : '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tag = `[mirror:${symbol}]`;
    child.stdout?.on('data', (d: Buffer) => process.stderr.write(`${tag} ${d}`));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`${tag} ${d}`));

    // resolve only once the OS has actually launched it; surface ENOENT/EACCES to the caller
    const launched = new Promise<void>((res, rej) => {
      child.once('spawn', () => res());
      child.once('error', (e) => rej(e));
    });
    // persistent handlers — 'error' must always be handled or it becomes an uncaughtException.
    // only mutate the map when it still refers to THIS child (avoid evicting a restarted mirror).
    child.on('error', (e: Error) => {
      this.log.err(`mirror ${symbol} error`, e.message);
      if (this.mirrors.get(k)?.child === child) this.mirrors.delete(k);
    });
    child.on('exit', (code) => {
      this.log.info(`mirror ${symbol} exited (code ${code ?? 'signal'})`);
      if (this.mirrors.get(k)?.child === child) this.mirrors.delete(k);
    });

    try {
      await launched;
    } catch (e) {
      throw new Error(`mirror launch failed for ${symbol}: ${(e as Error).message} (is ${botsDir} installed?)`);
    }

    const mirror: Mirror = { symbol, market, child, pid: child.pid ?? -1, startedAt: Date.now() };
    this.mirrors.set(k, mirror);
    this.log.ok(`mirror started for ${symbol} (pid ${mirror.pid})`);
    return this.toStatus(mirror);
  }

  stopMirror(symbol: string, market: Market = 'SPOT'): { stopped: string; market: Market } {
    const m = this.mirrors.get(key(market, symbol));
    if (!m) throw new Error(`no mirror running for ${market} ${symbol}`);
    m.child.kill('SIGINT'); // bots cancels its maker orders on SIGINT
    this.mirrors.delete(key(market, symbol));
    this.log.ok(`mirror stop signalled for ${symbol}`);
    return { stopped: symbol, market };
  }

  list(): MirrorStatus[] {
    return [...this.mirrors.values()].map((m) => this.toStatus(m));
  }

  listTickers() {
    return this.admin.listTickers();
  }

  stopAll(): void {
    for (const m of this.mirrors.values()) m.child.kill('SIGINT');
    this.mirrors.clear();
  }

  private toStatus(m: Mirror): MirrorStatus {
    return { symbol: m.symbol, market: m.market, pid: m.pid, uptimeMs: Date.now() - m.startedAt };
  }
}
