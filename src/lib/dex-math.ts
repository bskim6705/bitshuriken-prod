// 클라이언트 스왑 프리뷰 — BE getAmountOut를 10^8 스케일 정수로 미러(floor 동일).
// float 왕복 없음. 권위 있는 실행은 BE이며, minReceived(슬리피지 하한)가 드리프트를 막는다.
// 이 FE의 tsconfig target은 ES2020 미만 — BigInt 리터럴(10n) 금지, BigInt() 생성자 사용.

const SCALE = 8;
const SCALE_FACTOR = BigInt(10) ** BigInt(SCALE);
const ZERO = BigInt(0);
const BPS = BigInt(10000);
const HUNDRED = BigInt(100);
export const NUMERIC_RE = /^\d*\.?\d*$/;

/** 십진 문자열 → 10^8 스케일 BigInt. 파싱 불가 시 null. */
export function toScaled(v: string): bigint | null {
  if (v === "" || v === "." || !NUMERIC_RE.test(v)) return null;
  const [int, frac = ""] = v.split(".");
  return BigInt(int || "0") * SCALE_FACTOR + BigInt((frac + "0".repeat(SCALE)).slice(0, SCALE));
}

/** 10^8 스케일 BigInt → prec 자리 고정 소수 문자열. */
export function formatScaled(s: bigint, prec = 8): string {
  const neg = s < ZERO;
  const a = neg ? -s : s;
  const str = a.toString().padStart(SCALE + 1, "0");
  const int = str.slice(0, -SCALE);
  const frac = prec > 0 ? "." + str.slice(-SCALE).slice(0, prec) : "";
  return (neg ? "-" : "") + int + frac;
}

export interface SwapPreview {
  amountOut: string; // 8dp
  minReceived: string; // 8dp — BE로 보낼 minAmountOut
  feeQty: string; // 입력 자산 수수료
  priceImpactBps: number;
  rate: string; // out per in
}

/**
 * 상수곱 getAmountOut를 정수 스케일로 계산. reserves/amountIn은 십진 문자열,
 * feeBps/slippageBps는 정수. BE와 동일하게 floor → 표시값과 실행값이 일치.
 */
export function previewSwap(
  reserveIn: string,
  reserveOut: string,
  amountIn: string,
  feeBps: number,
  slippageBps: number,
): SwapPreview | null {
  const rIn = toScaled(reserveIn);
  const rOut = toScaled(reserveOut);
  const aIn = toScaled(amountIn);
  if (rIn === null || rOut === null || aIn === null || rIn <= ZERO || rOut <= ZERO || aIn <= ZERO) {
    return null;
  }
  const feeNum = BigInt(10000 - feeBps);
  const aInWithFee = aIn * feeNum; // ×10^4
  const amountOut = (aInWithFee * rOut) / (rIn * BPS + aInWithFee); // 10^8 스케일, floor
  if (amountOut <= ZERO) return null;
  const minReceived = (amountOut * BigInt(10000 - slippageBps)) / BPS;
  const feeQty = (aIn * BigInt(feeBps)) / BPS;

  // price impact bps = 10000 − (amountOut·rIn)/(aIn·rOut)·10000 (mid 대비 체결가 하락폭)
  const den = aIn * rOut;
  const execOverMidBps = den > ZERO ? Number((amountOut * rIn * BPS) / den) : 0;
  const priceImpactBps = Math.max(0, 10000 - execOverMidBps);

  const rateScaled = (amountOut * SCALE_FACTOR) / aIn;
  return {
    amountOut: formatScaled(amountOut),
    minReceived: formatScaled(minReceived),
    feeQty: formatScaled(feeQty),
    priceImpactBps,
    rate: formatScaled(rateScaled),
  };
}

/** avail의 pct(%)를 8dp 문자열로. */
export function pctOf(avail: string, pct: number): string | null {
  const s = toScaled(avail);
  if (s === null) return null;
  return formatScaled((s * BigInt(Math.round(pct * 100))) / HUNDRED);
}

/** reserve 비율로 짝 자산 수량 = amount × reserveTo / reserveFrom. */
export function ratioCounter(amount: string, reserveFrom: string, reserveTo: string): string | null {
  const a = toScaled(amount);
  const rf = toScaled(reserveFrom);
  const rt = toScaled(reserveTo);
  if (a === null || rf === null || rt === null || rf <= ZERO) return null;
  return formatScaled((a * rt) / rf);
}

/** 풀이 시드됐는지(reserve > 0). */
export function isSeeded(reserveBase: string): boolean {
  const s = toScaled(reserveBase);
  return s !== null && s > ZERO;
}
