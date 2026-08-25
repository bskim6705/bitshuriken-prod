import type { Bar, Market, Side, SymbolSpec } from '../core/types';
import type { Logger } from '../core/logger';

export type { Bar };

/** A realized fill delivered to a strategy (live: order response / sim: matched). */
export interface Fill {
  orderId: string;
  side: Side;
  price: number;
  qty: number;
  fee: number;
  feeAsset: string;
  isMaker: boolean;
  time: number;
}

/** Net position the broker tracks for the strategy. */
export interface Position {
  qty: number; // signed: + long, - short. spot is long-only.
  avgEntry: number;
}

/** What a strategy asks the broker to do; the broker enforces precision + min-notional.
 *  LIMIT postOnly=true → maker-only (POST_ONLY GTC): 즉시 크로스면 거절되고 submit이 null을 반환. */
export type OrderIntent =
  | { kind: 'MARKET'; side: Side; qty: number } // qty in base units
  | { kind: 'MARKET_QUOTE'; side: Side; quoteQty: number } // spot BUY by quote
  | { kind: 'LIMIT'; side: Side; price: number; qty: number; tif?: 'GTC' | 'IOC'; postOnly?: boolean }
  | { kind: 'CANCEL'; orderId: string }
  | { kind: 'FLATTEN' }; // close to a flat position

/** The only handle a strategy has on the outside world. Broker-agnostic (live or sim). */
export interface ExecutionContext {
  readonly spec: SymbolSpec;
  readonly market: Market;
  /** 주문 접수 시 orderId 반환 — 전략이 자기 resting 주문을 CANCEL로 지목할 수 있다.
   *  미접수(사이즈 0/민노셔널 미달/거절)·CANCEL·FLATTEN은 null. */
  submit(intent: OrderIntent): Promise<string | null>;
  position(): Position;
  /** mark-to-market equity in quote (USDT). sim: ledger; live: balances + last mark. */
  equityUsdt(): number;
  /** deterministic clock: wall time live, bar time in sim. */
  now(): number;
  readonly log: Logger;
}

export type ParamValue = number | string | boolean;
export type StrategyParams = Record<string, ParamValue>;

/** Pure decision logic. Holds its own indicator state; runs unchanged under both brokers. */
export interface Strategy {
  readonly id: string;
  /** bars of history to seed before signals are valid. */
  readonly warmupBars: number;
  init(ctx: ExecutionContext, params: StrategyParams): void;
  /** seed indicator state from history without emitting orders. */
  warmup(bars: Bar[]): void;
  /** the decision point — called once per FINAL bar. May ctx.submit(). */
  onBar(bar: Bar): Promise<void> | void;
  /** optional intrabar price updates (live trade ticks). */
  onTick?(price: number, time: number): void;
  /** fill notifications, so the strategy can update its own bookkeeping. */
  onFill?(fill: Fill): void;
  /** live-tune params without losing indicator state. */
  applyParams(params: StrategyParams): void;
}

export interface ParamSpec {
  type: 'number' | 'string' | 'boolean';
  default: ParamValue;
  min?: number;
  max?: number;
  desc: string;
}

/** Module contract: every src/strategies/*.ts default-exports this. */
export interface StrategyFactory {
  id: string;
  paramSchema: Record<string, ParamSpec>;
  create(): Strategy;
}

/** Fill the default-of-each param into a full StrategyParams, overlaying any provided values. */
export function withDefaults(schema: Record<string, ParamSpec>, params: StrategyParams = {}): StrategyParams {
  const out: StrategyParams = {};
  for (const [k, spec] of Object.entries(schema)) out[k] = params[k] ?? spec.default;
  return out;
}
