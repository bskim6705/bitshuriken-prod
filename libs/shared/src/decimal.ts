import { Decimal } from '@prisma/client/runtime/library';

// 8dp 정밀도/스케일 단일 출처. Kafka 메시지는 ×10^8 정수 string, BE 내부는 Decimal.

export const SCALE = new Decimal(10).pow(8);

/** 8dp floor (−∞ 방향). */
export function floor8(v: Decimal): Decimal {
  return v.toDecimalPlaces(8, Decimal.ROUND_FLOOR);
}

/** 8dp ceil (+∞ 방향). */
export function ceil8(v: Decimal): Decimal {
  return v.toDecimalPlaces(8, Decimal.ROUND_CEIL);
}

/** Decimal → ×10^8 정수 string (Kafka 메시지용). */
export function toScaledIntString(value: Decimal.Value): string {
  return new Decimal(value).mul(SCALE).toFixed(0);
}

/** ×10^8 정수 string → Decimal. */
export function fromScaledIntString(value: string): Decimal {
  return new Decimal(value).div(SCALE);
}

/** ×10^8 정수 string → precision 자리 표시 string. */
export function fmtScaled(scaledIntStr: string, precision: number): string {
  return new Decimal(scaledIntStr).div(SCALE).toFixed(precision);
}
