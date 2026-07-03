import { Prisma } from '@prisma/client';
import { buildLeaderboard, displayNameFor, maskEmail, type UserAgg } from './leaderboard.util';

const D = (v: string | number) => new Prisma.Decimal(v);

function agg(over: Partial<UserAgg> & Pick<UserAgg, 'userId'>): UserAgg {
  return {
    name: over.userId,
    startEquity: null,
    endEquity: null,
    netDeposit: D(0),
    volume: D(0),
    ...over,
  };
}

describe('maskEmail', () => {
  it('keeps first 2 chars + domain', () => {
    expect(maskEmail('mall@fc.co.kr')).toBe('ma***@fc.co.kr');
  });
  it('handles short local part', () => {
    expect(maskEmail('a@b.com')).toBe('a***@b.com');
  });
  it('returns *** when no @', () => {
    expect(maskEmail('not-an-email')).toBe('***');
  });
});

describe('displayNameFor', () => {
  it('prefers display name', () => {
    expect(displayNameFor('alpha-bot', 'mall@fc.co.kr')).toBe('alpha-bot');
  });
  it('falls back to masked email when null', () => {
    expect(displayNameFor(null, 'mall@fc.co.kr')).toBe('ma***@fc.co.kr');
  });
  it('falls back when blank', () => {
    expect(displayNameFor('   ', 'mall@fc.co.kr')).toBe('ma***@fc.co.kr');
  });
});

describe('buildLeaderboard', () => {
  it('computes pnl = end - start - netDeposit and roi = pnl/start*100', () => {
    const rows = buildLeaderboard(
      [agg({ userId: 'a', startEquity: D(10000), endEquity: D(24234), netDeposit: D(0) })],
      'ROI',
      10,
    );
    expect(rows[0].pnl?.toFixed(2)).toBe('14234.00');
    expect(rows[0].roi?.toFixed(2)).toBe('142.34');
  });

  it('subtracts external deposits from pnl (deposit is not profit)', () => {
    // +1000 deposit mid-window: equity grew 5000 but only 4000 is real pnl
    const rows = buildLeaderboard(
      [agg({ userId: 'a', startEquity: D(10000), endEquity: D(15000), netDeposit: D(1000) })],
      'ROI',
      10,
    );
    expect(rows[0].pnl?.toFixed(2)).toBe('4000.00');
    expect(rows[0].roi?.toFixed(2)).toBe('40.00');
  });

  it('ranks ROI descending', () => {
    const rows = buildLeaderboard(
      [
        agg({ userId: 'lo', startEquity: D(100), endEquity: D(110) }), // +10%
        agg({ userId: 'hi', startEquity: D(100), endEquity: D(150) }), // +50%
        agg({ userId: 'mid', startEquity: D(100), endEquity: D(120) }), // +20%
      ],
      'ROI',
      10,
    );
    expect(rows.map((r) => r.userId)).toEqual(['hi', 'mid', 'lo']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('puts unevaluable (no snapshot) rows last for ROI', () => {
    const rows = buildLeaderboard(
      [
        agg({ userId: 'none' }), // null equity
        agg({ userId: 'real', startEquity: D(100), endEquity: D(130) }),
      ],
      'ROI',
      10,
    );
    expect(rows[0].userId).toBe('real');
    expect(rows[1].userId).toBe('none');
    expect(rows[1].roi).toBeNull();
  });

  it('roi is null when start equity is zero (no division)', () => {
    const rows = buildLeaderboard(
      [agg({ userId: 'a', startEquity: D(0), endEquity: D(500) })],
      'PNL',
      10,
    );
    expect(rows[0].pnl?.toFixed(2)).toBe('500.00');
    expect(rows[0].roi).toBeNull();
  });

  it('ranks by VOLUME independent of equity', () => {
    const rows = buildLeaderboard(
      [agg({ userId: 'small', volume: D(1000) }), agg({ userId: 'big', volume: D(9999) })],
      'VOLUME',
      10,
    );
    expect(rows.map((r) => r.userId)).toEqual(['big', 'small']);
  });

  it('applies limit', () => {
    const rows = buildLeaderboard(
      [
        agg({ userId: 'a', volume: D(3) }),
        agg({ userId: 'b', volume: D(2) }),
        agg({ userId: 'c', volume: D(1) }),
      ],
      'VOLUME',
      2,
    );
    expect(rows.map((r) => r.userId)).toEqual(['a', 'b']);
  });
});
