import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { config } from './config';
import { intervalMs } from './core/binance';
import { makeLogger } from './core/logger';
import { buildConnectome } from './brain/build';
import { Connectome } from './brain/connectome';
import { loadModel } from './brain/model';
import { connectomePath, flyDir, modelPath, modelsDir, rawDir } from './brain/paths';
import { trainFly } from './brain/train';
import { backtest } from './trade/backtest';
import { FlyLive } from './trade/live';
import { LobRecorder } from './lob/recorder';
import { FlyBrain, DEFAULT_BRAIN } from './brain/brain';
import { LOB_FEATURES } from './lob/features';
import { LobLive } from './trade/lob-live';
import { evolve } from './evo/evolve';
import { League } from './league/league';
import { createLeagueServer } from './league/server';
import type { PolicyParams } from './trade/policy';
import { WARMUP_BARS } from './trade/trader';
import { createFlyServer } from './server';

const log = makeLogger('fly');

const USAGE = `fly — 초파리 커넥톰 트레이딩 뇌 (bitshuriken-prod-fly)
  build [region=central|full]            FlyWire v783 다운로드(최초 1회) → 커넥톰 바이너리 (data/)
  train <symbol> <interval> <days> [test=7] [horizon=15] [region=central]
        [gain=0.9] [normP=1.5] [leak=0.3] [substeps=4] [inputGain=3] [seed=7]
                                         Binance 이력에서 하강뉴런 판독 학습 → data/models/<SYMBOL>-<interval>.json
                                         마지막 test일은 학습에서 제외하고 백테스트로 out-of-sample 평가
  backtest <symbol> <interval> <days> [capital=] [maxFrac=0.5] [band=0.9] [minHoldBars=60]
  live <symbol> [mode=lob|bars] [capital=] [maxFrac=] [band=] [minHoldBars=]
                                         로컬 거래소에서 서브계정으로 거래 + 대시보드 :FLY_PORT.
                                         mode 기본: lob 모델(<SYMBOL>-1s.json)이 있으면 실시간, 없으면 bar(FLY_INTERVAL)
  evolve <symbol> [gens=8] [pop=16] [elite=4] [workers=6] [minTrades=5] [trainFrac=0.7] [seed=1] [run=<name>] [resume=true]
                                         기록(data/lob) 위에서 파리 진화: 뒤쪽 미학습 구간 순수익·승률 상위 보존 + 돌연변이
                                         → 최우수 파리를 data/models/<SYMBOL>-1s.json 으로 저장
  flatten <symbol>                       초파리 서브계정의 포지션 전량 시장가 매도
  record <symbol>                        실시간 호가창(top-20)·체결을 1초 샘플로 기록 → data/lob/<SYMBOL>/<date>.jsonl (진화용)
  league <symbol> [flies=8] [season=30] [relegate=3] [minTrades=2] [capital=10000] [seedFrom=<evolve run>] [workers=3] [fitHours=2]
                                         트레이딩 컴피티션: N마리 동시 라이브, 시즌(분)마다 순수익 순위 → 하위 relegate 탈락(청산)
                                         → 상위 파리 돌연변이 입장(판독은 최신 기록 재적합). 무거래(minTrades 미만)는 최하위. 대시보드 :FLY_PORT
  bench                                  이 기계의 뇌 스텝 시간 측정 → 파리 수 추천 (커넥톰 없으면 먼저 build)
  info                                   커넥톰·모델 목록`;

function kv(tokens: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tokens) {
    const [k, v] = t.split('=');
    if (k && v !== undefined) out[k] = v;
  }
  return out;
}
const positional = (args: string[]): string[] => args.filter((a) => !a.includes('='));
const num = (opts: Record<string, string>, k: string): number | undefined => (opts[k] !== undefined ? Number(opts[k]) : undefined);

function region(v: string | undefined): 'central' | 'full' {
  if (v === undefined || v === 'central') return 'central';
  if (v === 'full') return 'full';
  throw new Error(`region must be central|full, got "${v}"`);
}

function policyOf(opts: Record<string, string>): Partial<PolicyParams> {
  const p: Partial<PolicyParams> = {};
  for (const k of ['maxFrac', 'band', 'minHoldBars'] as const) {
    const v = num(opts, k);
    if (v !== undefined) p[k] = v;
  }
  return p;
}

function printPopulations(conn: Connectome): void {
  const rows = conn.meta.populations.filter((p) => p.end > p.start).map((p) => `  ${p.name.padEnd(15)} ${String(p.end - p.start).padStart(7)}`);
  console.log(`${conn.meta.dataset} ${conn.meta.region}: ${conn.N} neurons, ${conn.E} signed connections (built ${conn.meta.builtAt})\n${rows.join('\n')}`);
}

const pct = (x: number): number => +(x * 100).toFixed(2);

function printBacktest(r: Awaited<ReturnType<typeof backtest>>): void {
  const m = r.metrics;
  console.log(
    JSON.stringify(
      {
        symbol: r.symbol,
        interval: r.interval,
        from: new Date(r.from).toISOString(),
        to: new Date(r.to).toISOString(),
        tradedBars: r.tradedBars,
        roiPct: pct(m.roi),
        buyHoldRoiPct: pct(r.buyHoldRoi),
        totalPnl: +m.totalPnl.toFixed(2),
        maxDrawdownPct: pct(m.maxDrawdown),
        sharpe: +m.sharpe.toFixed(2),
        fills: m.trades,
        winRatePct: pct(m.winRate),
        feesPaid: +m.feesPaid.toFixed(2),
        avgExposurePct: pct(r.avgExposure),
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const opts = kv(args);
  const pos = positional(args);
  mkdirSync(flyDir(), { recursive: true });
  switch (cmd) {
    case 'build': {
      const r = region(opts.region);
      printPopulations(await buildConnectome({ region: r, rawDir: rawDir(), outPath: connectomePath(r), log }));
      return;
    }
    case 'train': {
      const [symbol, interval = '1m', daysStr = '30'] = pos;
      if (!symbol) throw new Error('train <symbol> <interval> <days> [test=7] [k=v ...]');
      const days = Number(daysStr);
      const testDays = Number(opts.test ?? 7);
      if (!(days > testDays)) throw new Error(`days (${days}) must exceed test days (${testDays})`);
      const now = Date.now();
      const cutoff = now - testDays * 86_400_000;
      const brain: Record<string, number> = {};
      for (const k of ['gain', 'normP', 'leak', 'substeps', 'inputGain', 'inputDensity', 'seed']) {
        const v = num(opts, k);
        if (v !== undefined) brain[k] = v;
      }
      const { model } = await trainFly({ symbol, interval, from: now - days * 86_400_000, to: cutoff, horizon: num(opts, 'horizon'), region: region(opts.region), brain }, log);
      console.log(
        JSON.stringify(
          {
            model: `${model.symbol}-${model.interval}`,
            rows: model.train.rows,
            lambda: model.train.lambda,
            valIc: +model.train.val.best.ic.toFixed(4),
            valHitRatePct: pct(model.train.val.best.hitRate),
            inSampleIc: +model.train.inSampleIc.toFixed(4),
            echoDiff: model.train.echoDiff,
            msPerBar: +model.train.msPerBar.toFixed(1),
          },
          null,
          2,
        ),
      );
      if (testDays > 0) {
        log.info(`out-of-sample backtest on the last ${testDays} days …`);
        printBacktest(await backtest({ symbol, interval, from: cutoff - (WARMUP_BARS + 5) * intervalMs(interval), to: now, policy: policyOf(opts) }, log));
      }
      return;
    }
    case 'backtest': {
      const [symbol, interval = '1m', daysStr = '7'] = pos;
      if (!symbol) throw new Error('backtest <symbol> <interval> <days> [k=v ...]');
      const to = Date.now();
      const from = to - Number(daysStr) * 86_400_000 - (WARMUP_BARS + 5) * intervalMs(interval);
      printBacktest(await backtest({ symbol, interval, from, to, capital: num(opts, 'capital'), policy: policyOf(opts) }, log));
      return;
    }
    case 'live': {
      const [symbol] = pos;
      if (!symbol) throw new Error('live <symbol> [mode=lob|bars] [capital=] [k=v ...]');
      const sym = symbol.toUpperCase();
      const mode = opts.mode ?? (existsSync(modelPath(sym, '1s')) ? 'lob' : 'bars');
      const live = mode === 'lob' ? new LobLive(sym, { capital: num(opts, 'capital'), log }) : new FlyLive(sym, { capital: num(opts, 'capital'), policy: policyOf(opts), log });
      await live.start();
      const server = createFlyServer(live);
      server.listen(config.port, config.host, () => log.ok(`dashboard → http://${config.host}:${config.port}`));
      const shutdown = (sig: string): void => {
        log.info(`${sig} — the fly goes to sleep (position kept; \`npm run fly flatten ${symbol}\` to sell)`);
        live.stop();
        server.close();
        process.exit(0);
      };
      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      return;
    }
    case 'evolve': {
      const [symbol] = pos;
      if (!symbol) throw new Error('evolve <symbol> [gens=8] [pop=16] [elite=4] [workers=6] [minTrades=5]');
      await evolve(
        {
          symbol: symbol.toUpperCase(),
          generations: num(opts, 'gens') ?? 8,
          population: num(opts, 'pop') ?? 16,
          elite: num(opts, 'elite') ?? 4,
          workers: num(opts, 'workers') ?? 6,
          minTrades: num(opts, 'minTrades') ?? 5,
          trainFrac: num(opts, 'trainFrac') ?? 0.7,
          seed: num(opts, 'seed') ?? 1,
          region: region(opts.region),
          resume: opts.resume === 'true',
          run: opts.run ?? new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ''),
        },
        log,
      );
      return;
    }
    case 'league': {
      const [symbol] = pos;
      if (!symbol) throw new Error('league <symbol> [flies=8] [season=30] [relegate=3] [minTrades=2] [capital=10000] [seedFrom=<run>]');
      const league = new League(
        {
          symbol: symbol.toUpperCase(),
          flies: num(opts, 'flies') ?? 8,
          seasonMin: num(opts, 'season') ?? 30,
          relegate: num(opts, 'relegate') ?? 3,
          minTrades: num(opts, 'minTrades') ?? 2,
          capital: num(opts, 'capital') ?? 10_000,
          seedFrom: opts.seedFrom,
          workers: num(opts, 'workers') ?? 3,
          seed: num(opts, 'seed') ?? Date.now() % 1_000_000,
          fitWindowHours: num(opts, 'fitHours') ?? 2,
        },
        log,
      );
      await league.start();
      const server = createLeagueServer(league);
      server.listen(config.port, config.host, () => log.ok(`league dashboard → http://${config.host}:${config.port}`));
      let down = false;
      const shutdown = async (sig: string): Promise<void> => {
        if (down) return;
        down = true;
        log.info(`${sig} — closing the league (every fly flattens)`);
        server.close();
        await league.stop();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      return;
    }
    case 'record': {
      const [symbol] = pos;
      if (!symbol) throw new Error('record <symbol>');
      const rec = new LobRecorder(symbol.toUpperCase(), log);
      rec.start();
      const stop = (): void => {
        rec.stop();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    case 'flatten': {
      const [symbol] = pos;
      if (!symbol) throw new Error('flatten <symbol>');
      const live = new FlyLive(symbol.toUpperCase(), { log });
      await live.start();
      live.stop();
      console.log(await live.flattenAll());
      return;
    }
    case 'bench': {
      const p = connectomePath('central');
      if (!existsSync(p)) await buildConnectome({ region: 'central', rawDir: rawDir(), outPath: p, log });
      const conn = Connectome.load(p);
      const brain = new FlyBrain(conn, DEFAULT_BRAIN, LOB_FEATURES);
      const f = new Float32Array(LOB_FEATURES.length);
      for (let i = 0; i < 5; i++) brain.step(f); // JIT warm-up
      const t0 = performance.now();
      const n = 20;
      for (let i = 0; i < n; i++) {
        for (let k = 0; k < f.length; k++) f[k] = Math.sin(i + k) * 0.5;
        brain.step(f);
      }
      const ms = (performance.now() - t0) / n;
      // 1초 주기에서 파리들이 CPU 절반 이내를 쓰도록: 500ms / step
      const flies = Math.max(1, Math.min(16, Math.floor(500 / ms)));
      console.log(JSON.stringify({ neurons: conn.N, synapses: conn.E, msPerStep: +ms.toFixed(1), substeps: DEFAULT_BRAIN.substeps, recommendedFlies: flies, note: `${ms.toFixed(0)}ms per 1s brain step → up to ${flies} flies within half a core` }, null, 2));
      return;
    }
    case 'info': {
      for (const r of ['central', 'full'] as const) {
        const p = connectomePath(r);
        if (existsSync(p)) printPopulations(Connectome.load(p));
        else console.log(`${r}: not built (npm run fly build region=${r})`);
      }
      const dir = modelsDir();
      const models = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
      if (!models.length) console.log(`models: (none — npm run fly train <symbol> <interval> <days>)`);
      for (const f of models) {
        const m = loadModel(`${dir}/${f}`);
        console.log(`model ${f}: H=${m.horizon} λ=${m.train.lambda} val IC ${m.train.val.best.ic.toFixed(4)} hit ${(m.train.val.best.hitRate * 100).toFixed(1)}% rows ${m.train.rows} trained ${m.trainedAt}`);
      }
      return;
    }
    default:
      console.log(USAGE);
  }
}

main().catch((e) => {
  log.err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
