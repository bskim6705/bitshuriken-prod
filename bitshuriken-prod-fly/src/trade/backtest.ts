import { config } from '../config';
import { fetchHistory, fetchSpec, intervalMs } from '../core/binance';
import type { Logger } from '../core/logger';
import { floorQty } from '../core/precision';
import type { EquityPoint, Fill } from '../core/types';
import { computeMetrics, type Metrics } from './metrics';
import type { Decision, PolicyParams } from './policy';
import { FlyTrader } from './trader';

export interface BacktestArgs {
  symbol: string;
  interval: string;
  from: number;
  to: number;
  capital?: number;
  policy?: Partial<PolicyParams>;
  modelFile?: string;
  feeBps?: number;
  slippageBps?: number;
}

export interface BacktestResult {
  symbol: string;
  interval: string;
  from: number;
  to: number;
  bars: number;
  tradedBars: number;
  capital: number;
  metrics: Metrics;
  /** 같은 구간 현금→풀 매수 후 보유 수익률 (비교 기준). */
  buyHoldRoi: number;
  avgExposure: number;
  equityCurve: EquityPoint[];
  fills: Fill[];
}

/**
 * Binance 이력 재생. bar 종가에서 결정 → 다음 bar 시가(± slippage)에 테이커 체결 (수수료 bps).
 * 결정론적: (bars, model, policy, fee)가 같으면 결과가 같다.
 */
export async function backtest(args: BacktestArgs, log: Logger): Promise<BacktestResult> {
  const capital = args.capital ?? config.capitalUsdt;
  const feeRate = (args.feeBps ?? config.sim.feeBps) / 10_000;
  const slip = (args.slippageBps ?? config.sim.slippageBps) / 10_000;
  const spec = await fetchSpec(args.symbol);
  const bars = await fetchHistory(args.symbol, args.interval, args.from, args.to);
  const trader = FlyTrader.load(args.symbol, args.interval, args.policy, args.modelFile);
  log.info(`backtest ${args.symbol} ${args.interval}: ${bars.length} bars, fee ${feeRate * 1e4}bps, slippage ${slip * 1e4}bps`);

  let cash = capital;
  let qty = 0;
  let pending: Decision | null = null;
  const fills: Fill[] = [];
  const curve: EquityPoint[] = [];
  let tradedBars = 0;
  let exposureSum = 0;
  let firstTradedClose = 0;
  let lastClose = 0;

  for (const bar of bars) {
    if (pending) {
      if (pending.kind === 'BUY') {
        const price = bar.open * (1 + slip);
        const q = Number(floorQty(spec, Math.min(pending.quoteQty, cash / (1 + feeRate)) / price));
        if (q > 0 && q * price >= spec.minNotional) {
          const fee = q * price * feeRate;
          cash -= q * price + fee;
          qty += q;
          fills.push({ time: bar.openTime, side: 'BUY', price, qty: q, fee });
          trader.markTraded();
        }
      } else if (pending.kind === 'SELL' || pending.kind === 'FLATTEN') {
        const price = bar.open * (1 - slip);
        const q = Number(floorQty(spec, pending.kind === 'FLATTEN' ? qty : Math.min(pending.qty, qty)));
        if (q > 0 && q * price >= spec.minNotional) {
          const fee = q * price * feeRate;
          cash += q * price - fee;
          qty -= q;
          fills.push({ time: bar.openTime, side: 'SELL', price, qty: q, fee });
          trader.markTraded();
        }
      }
      pending = null;
    }
    const yhat = trader.observe(bar);
    const equity = cash + qty * bar.close;
    curve.push({ t: bar.closeTime, equity });
    if (yhat === null || !trader.warm) continue;
    if (firstTradedClose === 0) firstTradedClose = bar.close;
    lastClose = bar.close;
    tradedBars++;
    exposureSum += (qty * bar.close) / equity;
    const d = trader.decide(yhat, { equity, price: bar.close, positionQty: qty });
    if (d.kind !== 'HOLD') pending = d;
  }

  const barsPerYear = (365 * 86_400_000) / intervalMs(args.interval);
  const traded = curve.slice(curve.length - tradedBars);
  const metrics = computeMetrics(capital, traded.length ? traded : curve, fills, barsPerYear);
  const result: BacktestResult = {
    symbol: args.symbol,
    interval: args.interval,
    from: args.from,
    to: args.to,
    bars: bars.length,
    tradedBars,
    capital,
    metrics,
    buyHoldRoi: firstTradedClose > 0 ? lastClose / firstTradedClose - 1 : 0,
    avgExposure: tradedBars ? exposureSum / tradedBars : 0,
    equityCurve: curve,
    fills,
  };
  log.ok(
    `ROI ${(metrics.roi * 100).toFixed(2)}% (buy&hold ${(result.buyHoldRoi * 100).toFixed(2)}%) over ${tradedBars} traded bars, ${fills.length} fills, maxDD ${(metrics.maxDrawdown * 100).toFixed(2)}%, Sharpe ${metrics.sharpe.toFixed(2)}, fees ${metrics.feesPaid.toFixed(2)}`,
  );
  return result;
}
