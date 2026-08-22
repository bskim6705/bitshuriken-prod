import { Injectable } from '@nestjs/common';
import { FundingTxType, Prisma } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import {
  buildLeaderboard,
  displayNameFor,
  type LeaderboardMetric,
  type LeaderboardWindow,
  type UserAgg,
} from './leaderboard.util';

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS: Record<Exclude<LeaderboardWindow, 'ALL'>, number> = {
  DAILY: 1,
  WEEKLY: 7,
  MONTHLY: 30,
};
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const METRICS = new Set<string>(['ROI', 'PNL', 'VOLUME']);
const WINDOWS = new Set<string>(['DAILY', 'WEEKLY', 'MONTHLY', 'ALL']);

export interface LeaderboardQuery {
  window?: string;
  metric?: string;
  limit?: number;
}

interface Equity {
  start: Prisma.Decimal;
  end: Prisma.Decimal;
}

/**
 * 공개 트레이딩 리더보드 — 윈도우(일/주/월/전체)별 ROI%/PnL/거래대금 랭킹.
 * ROI·PnL은 일별 BalanceSnapshot 순자산 델타(외부 입출금 보정), 거래대금은 Trade 집계.
 */
@Injectable()
export class LeaderboardService {
  constructor(private prisma: PrismaService) {}

  async list(q: LeaderboardQuery) {
    const window = this.parseWindow(q.window);
    const metric = this.parseMetric(q.metric);
    const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const windowStart =
      window === 'ALL' ? new Date(0) : new Date(Date.now() - WINDOW_DAYS[window] * DAY_MS);

    const [equity, deposits, volume] = await Promise.all([
      this.equityByUser(windowStart),
      this.netDepositByUser(windowStart),
      this.volumeByUser(windowStart),
    ]);

    const ids = new Set<string>([...equity.keys(), ...volume.keys()]);
    // 서브계정(parentUserId 있음)은 공개 랭킹에서 제외 — 마스터/일반 계정만
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...ids] }, parentUserId: null },
      select: { id: true, email: true, displayName: true },
    });

    const aggs: UserAgg[] = users.map((u) => {
      const eq = equity.get(u.id);
      return {
        userId: u.id,
        name: displayNameFor(u.displayName, u.email),
        startEquity: eq?.start ?? null,
        endEquity: eq?.end ?? null,
        netDeposit: deposits.get(u.id) ?? new Prisma.Decimal(0),
        volume: volume.get(u.id) ?? new Prisma.Decimal(0),
      };
    });

    const rows = buildLeaderboard(aggs, metric, limit);
    return {
      window,
      metric,
      rows: rows.map((r) => ({
        rank: r.rank,
        userId: r.userId,
        name: r.name,
        roi: r.roi !== null ? r.roi.toFixed(2) : null,
        pnl: r.pnl !== null ? r.pnl.toFixed(8) : null,
        volume: r.volume.toFixed(8),
        startEquity: r.startEquity !== null ? r.startEquity.toFixed(8) : null,
        endEquity: r.endEquity !== null ? r.endEquity.toFixed(8) : null,
      })),
    };
  }

  /** 유저별 윈도우 시작/최신 순자산. baseline = windowStart 이하 마지막 스냅샷, 없으면 윈도우 내 최초. */
  private async equityByUser(windowStart: Date): Promise<Map<string, Equity>> {
    const snaps = await this.prisma.balanceSnapshot.findMany({
      orderBy: { day: 'asc' },
      select: { userId: true, day: true, totalUsdt: true },
    });

    const byUser = new Map<string, { day: Date; totalUsdt: Prisma.Decimal }[]>();
    for (const s of snaps) {
      const arr = byUser.get(s.userId) ?? [];
      arr.push({ day: s.day, totalUsdt: s.totalUsdt });
      byUser.set(s.userId, arr);
    }

    const out = new Map<string, Equity>();
    for (const [userId, arr] of byUser) {
      const end = arr[arr.length - 1].totalUsdt;
      let baseline = arr[0]; // 윈도우 내 진입(이전 스냅샷 없음) 기본값
      for (const s of arr) {
        if (s.day.getTime() <= windowStart.getTime()) baseline = s;
        else break;
      }
      out.set(userId, { start: baseline.totalUsdt, end });
    }
    return out;
  }

  /** 윈도우 내 USDT 외부 입출금 순합(입금−출금). 이체/비USDT는 평가 단위 보존을 위해 제외. */
  private async netDepositByUser(windowStart: Date): Promise<Map<string, Prisma.Decimal>> {
    const rows = await this.prisma.fundingTx.findMany({
      where: {
        createdAt: { gte: windowStart },
        type: { in: [FundingTxType.DEPOSIT, FundingTxType.WITHDRAWAL] },
        status: 'COMPLETED',
        assetSymbol: 'USDT',
      },
      select: { userId: true, type: true, qty: true },
    });

    const out = new Map<string, Prisma.Decimal>();
    for (const r of rows) {
      const signed = r.type === FundingTxType.WITHDRAWAL ? r.qty.neg() : r.qty;
      out.set(r.userId, (out.get(r.userId) ?? new Prisma.Decimal(0)).plus(signed));
    }
    return out;
  }

  /** 윈도우 내 체결 거래대금(price*qty) — maker/taker 양면 합산. */
  private async volumeByUser(windowStart: Date): Promise<Map<string, Prisma.Decimal>> {
    const rows = await this.prisma.$queryRaw<Array<{ userId: string; volume: string }>>`
      SELECT u_id AS "userId", SUM(vol)::text AS volume
      FROM (
        SELECT "makerUserId" AS u_id, "price" * "qty" AS vol
        FROM "Trade" WHERE "executedAt" >= ${windowStart}
        UNION ALL
        SELECT "takerUserId" AS u_id, "price" * "qty" AS vol
        FROM "Trade" WHERE "executedAt" >= ${windowStart}
      ) t
      GROUP BY u_id
    `;

    const out = new Map<string, Prisma.Decimal>();
    for (const r of rows) out.set(r.userId, new Prisma.Decimal(r.volume));
    return out;
  }

  private parseWindow(w?: string): LeaderboardWindow {
    const up = (w ?? 'WEEKLY').toUpperCase();
    if (!WINDOWS.has(up))
      throw new DomainException(ErrorCode.INVALID_PARAMETER, `Invalid window: ${w}`);
    return up as LeaderboardWindow;
  }

  private parseMetric(m?: string): LeaderboardMetric {
    const up = (m ?? 'ROI').toUpperCase();
    if (!METRICS.has(up))
      throw new DomainException(ErrorCode.INVALID_PARAMETER, `Invalid metric: ${m}`);
    return up as LeaderboardMetric;
  }
}
