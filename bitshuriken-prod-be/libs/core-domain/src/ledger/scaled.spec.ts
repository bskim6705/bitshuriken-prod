import { Decimal } from '@prisma/client/runtime/library';
import { formatScaled, fromScaledBigint, toScaledBigint } from './scaled';

describe('scaled (Decimal ↔ ×10^8 bigint)', () => {
  it('converts whole and 8dp values exactly', () => {
    expect(toScaledBigint('1.00000000')).toBe(100000000n);
    expect(toScaledBigint('0.00000001')).toBe(1n);
    expect(toScaledBigint('50000.12345678')).toBe(5000012345678n);
    expect(toScaledBigint(new Decimal('0'))).toBe(0n);
  });

  it('floors precision beyond 8dp (−∞ direction, 엔진 규율)', () => {
    // 1.234567895 → 123456789.5 → floor → 123456789
    expect(toScaledBigint('1.234567895')).toBe(123456789n);
    expect(toScaledBigint('0.000000019')).toBe(1n);
    // 음수는 −∞ 방향 floor (floor8와 동일 ROUND_FLOOR)
    expect(toScaledBigint('-1.00000000')).toBe(-100000000n);
    expect(toScaledBigint('-0.000000004')).toBe(-1n);
  });

  it('rejects non-finite amounts (fail loudly)', () => {
    expect(() => toScaledBigint(new Decimal(NaN))).toThrow(/non-finite/);
    expect(() => toScaledBigint(new Decimal(Infinity))).toThrow(/non-finite/);
  });

  it('round-trips through Decimal', () => {
    expect(fromScaledBigint(12345678900n).toFixed(8)).toBe('123.45678900');
    expect(fromScaledBigint(-1n).toFixed(8)).toBe('-0.00000001');
    expect(formatScaled(5000012345678n)).toBe('50000.12345678');
  });
});
