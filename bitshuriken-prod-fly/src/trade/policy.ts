/**
 * 판독값 → 롱 노출(0..1) → 주문. spot 롱온리. 수수료 churn을 막는 데드밴드 + 최소 보유 bar.
 * 기본값은 실측(2026-09-16 BTCUSDT 1m, 테이커 10bps+슬리피지 2bps): band 0.25/hold 3은 7일 1,196 체결로
 * 수수료 −20%p, band 0.9/hold 60은 3일 23 체결 −3.0% (buy&hold −2.2%). 신호(IC 0.04)가 왕복 24bps를
 * 못 넘으므로 거래를 드물게 하는 쪽이 항상 덜 잃었다.
 */
export interface PolicyParams {
  maxFrac: number; // 풀 노출 시 equity 비율
  band: number; // 목표 노출 변화가 이 비율(maxFrac 기준) 미만이면 거래 안 함
  minHoldBars: number; // 거래 후 최소 대기 bar
}
export const DEFAULT_POLICY: PolicyParams = { maxFrac: 0.5, band: 0.9, minHoldBars: 60 };

export type Decision =
  | { kind: 'BUY'; quoteQty: number }
  | { kind: 'SELL'; qty: number }
  | { kind: 'FLATTEN' }
  | { kind: 'HOLD'; reason: string };

/** ŷ ≥ yScale이면 풀 노출, ≤ 0이면 현금. */
export const exposureOf = (yhat: number, yScale: number): number => Math.min(1, Math.max(0, yhat / yScale));

export interface AccountView {
  equity: number;
  price: number;
  positionQty: number;
}

export function decide(exposure: number, acct: AccountView, barsSinceTrade: number, p: PolicyParams): Decision {
  const targetNotional = acct.equity * p.maxFrac * exposure;
  const currentNotional = acct.positionQty * acct.price;
  const delta = targetNotional - currentNotional;
  const threshold = p.band * p.maxFrac * acct.equity;
  if (Math.abs(delta) < threshold) return { kind: 'HOLD', reason: 'inside band' };
  if (barsSinceTrade < p.minHoldBars) return { kind: 'HOLD', reason: 'min hold' };
  if (delta > 0) return { kind: 'BUY', quoteQty: delta };
  if (exposure === 0 && acct.positionQty > 0) return { kind: 'FLATTEN' };
  return { kind: 'SELL', qty: Math.min(acct.positionQty, -delta / acct.price) };
}
