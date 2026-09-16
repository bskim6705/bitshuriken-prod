import type { Level, Trade } from './stream';

/** 고정 주기(1s) 원시 샘플 — 기록·리플레이의 단위. 피처는 여기서 매번 다시 계산한다(피처 코드가 바뀌어도 기록은 유효). */
export interface LobSample {
  t: number; // 샘플 시각 (ms, 초 정렬)
  bids: Level[]; // top-N 내림차순
  asks: Level[]; // top-N 오름차순
  trades: [number, number, number, 1 | -1][]; // [ts, price, qty, takerSide] — 직전 샘플 이후
  depthMsgs: number; // 직전 샘플 이후 depth 갱신 수 (활동량)
}

export const mid = (s: LobSample): number => (s.bids.length && s.asks.length ? (s.bids[0]![0] + s.asks[0]![0]) / 2 : NaN);

export function toTradeRows(trades: Trade[]): LobSample['trades'] {
  return trades.map((t) => [t.ts, t.price, t.qty, t.side]);
}
