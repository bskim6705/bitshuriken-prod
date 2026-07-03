import { Prisma } from '@prisma/client';

type Decimal = Prisma.Decimal;

export type LeaderboardMetric = 'ROI' | 'PNL' | 'VOLUME';
export type LeaderboardWindow = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ALL';

/** 유저 1명의 윈도우 집계 — 평가/정렬 입력. */
export interface UserAgg {
  userId: string;
  name: string;
  startEquity: Decimal | null; // 윈도우 시작 순자산 (스냅샷 없으면 null)
  endEquity: Decimal | null; // 최신 순자산
  netDeposit: Decimal; // 윈도우 내 외부 유입(입금−출금), 이체 제외
  volume: Decimal; // 윈도우 내 체결 거래대금(quote)
}

export interface LeaderboardRow {
  rank: number;
  userId: string;
  name: string;
  roi: Decimal | null; // 퍼센트
  pnl: Decimal | null; // USDT
  volume: Decimal;
  startEquity: Decimal | null;
  endEquity: Decimal | null;
}

const ZERO = new Prisma.Decimal(0);
const HUNDRED = new Prisma.Decimal(100);

/** 이메일 마스킹: 앞 2자 + *** + 도메인. "mall@fc.co.kr" → "ma***@fc.co.kr". */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

/** 공개 표시 이름 — displayName 우선, 없으면 마스킹 이메일. */
export function displayNameFor(displayName: string | null, email: string): string {
  const trimmed = displayName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : maskEmail(email);
}

/** UserAgg → PnL/ROI 평가 + metric 정렬 + rank 부여 + limit 절단. 순수 함수. */
export function buildLeaderboard(
  aggs: UserAgg[],
  metric: LeaderboardMetric,
  limit: number,
): LeaderboardRow[] {
  const rows: Omit<LeaderboardRow, 'rank'>[] = aggs.map((a) => {
    const { startEquity, endEquity } = a;
    let pnl: Decimal | null = null;
    let roi: Decimal | null = null;
    if (startEquity !== null && endEquity !== null) {
      pnl = endEquity.minus(startEquity).minus(a.netDeposit);
      roi = startEquity.gt(ZERO) ? pnl.div(startEquity).times(HUNDRED) : null;
    }
    return {
      userId: a.userId,
      name: a.name,
      roi,
      pnl,
      volume: a.volume,
      startEquity,
      endEquity,
    };
  });

  rows.sort((x, y) => compareByMetric(x, y, metric));

  return rows.slice(0, limit).map((r, i) => ({ rank: i + 1, ...r }));
}

/** metric 기준 내림차순. 평가 불가(null) 값은 항상 뒤로. */
function compareByMetric(
  x: Omit<LeaderboardRow, 'rank'>,
  y: Omit<LeaderboardRow, 'rank'>,
  metric: LeaderboardMetric,
): number {
  if (metric === 'VOLUME') return y.volume.cmp(x.volume);
  const xv = metric === 'ROI' ? x.roi : x.pnl;
  const yv = metric === 'ROI' ? y.roi : y.pnl;
  if (xv === null && yv === null) return 0;
  if (xv === null) return 1;
  if (yv === null) return -1;
  return yv.cmp(xv);
}
