import { MarketType } from '@prisma/client';

export const Op = {
  NEW_ORDER: 'NO',
  CANCEL_ORDER: 'CO',
  TRADE: 'TR',
  ORDER_UPDATE: 'OU',
  DEPTH_DIFF: 'DPD',
} as const;

/** Control topic ops (런타임 ticker 상장). */
export const ControlOp = {
  ADD_TICKER: 'ADD',
} as const;

/** Control 토픽은 1 partition(compacted, key=symbol). */
export const CONTROL_PARTITION = 0;

export type OpCode = (typeof Op)[keyof typeof Op];

const MARKET_SLUG: Record<MarketType, string> = {
  SPOT: 'spot',
  FUTURES: 'futures',
};

export function inboundTopic(market: MarketType): string {
  return `match.${MARKET_SLUG[market]}.in`;
}

export function outboundTopic(market: MarketType): string {
  return `match.${MARKET_SLUG[market]}.out`;
}

/** Orderbook diff stream용 별도 topic. */
export function bookTopic(market: MarketType): string {
  return `match.${MARKET_SLUG[market]}.book`;
}

/** Ticker 라이프사이클 컨트롤용 log-compacted topic. */
export function controlTopic(market: MarketType): string {
  return `match.${MARKET_SLUG[market]}.control`;
}

export const ALL_OUTBOUND_TOPICS: string[] = (Object.keys(MARKET_SLUG) as MarketType[]).map(
  outboundTopic,
);
