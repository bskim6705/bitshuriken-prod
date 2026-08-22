import { Decimal } from '@prisma/client/runtime/library';

// ADR-069 원장은 잔고를 ×10^8 정수 bigint로 보유한다 (매칭엔진과 동일 규율: 정수 산술, 항상 floor,
// 부동소수점 금지). BE 경계는 Decimal이므로 이 두 헬퍼가 유일한 변환 지점이다.

/** 원장 스케일 = 8dp. */
export const LEDGER_SCALE_DP = 8;

const SCALE_DEC = new Decimal(10).pow(LEDGER_SCALE_DP);

/**
 * Decimal(또는 string/number) → ×10^8 정수 bigint.
 * 엔진 규율대로 floor(−∞ 방향)로 8dp 초과분을 절삭 — 8dp 값은 정확 변환, 초과 입력은 방어적 절삭.
 * NaN/Infinity 등 비유한 값은 throw (조용한 오적용 금지 — fail loudly).
 */
export function toScaledBigint(value: Decimal.Value): bigint {
  const d = new Decimal(value);
  if (!d.isFinite()) {
    throw new Error(`ledger: refuse to scale non-finite amount "${d.toString()}"`);
  }
  const scaled = d.mul(SCALE_DEC).toDecimalPlaces(0, Decimal.ROUND_FLOOR);
  return BigInt(scaled.toFixed(0));
}

/** ×10^8 정수 bigint → Decimal (8dp). */
export function fromScaledBigint(scaled: bigint): Decimal {
  return new Decimal(scaled.toString()).div(SCALE_DEC);
}

/** ×10^8 정수 bigint → 사람이 보는 8dp string. */
export function formatScaled(scaled: bigint): string {
  return fromScaledBigint(scaled).toFixed(LEDGER_SCALE_DP);
}
