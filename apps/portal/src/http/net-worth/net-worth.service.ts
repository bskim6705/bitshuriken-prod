import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/infra/prisma/prisma.service';

const DEFAULT_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface NetWorthQuery {
  from?: number;
  to?: number;
}

/** 일별 순자산 시계열 조회 — 저장된 BalanceSnapshot을 그대로 반환(가격 재계산 없음). */
@Injectable()
export class NetWorthService {
  constructor(private prisma: PrismaService) {}

  async series(userId: string, q: NetWorthQuery) {
    const to = q.to !== undefined ? new Date(q.to) : new Date();
    const from =
      q.from !== undefined ? new Date(q.from) : new Date(to.getTime() - DEFAULT_DAYS * DAY_MS);

    const rows = await this.prisma.balanceSnapshot.findMany({
      where: { userId, day: { gte: from, lte: to } },
      orderBy: { day: 'asc' },
    });

    return rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      time: r.day.getTime(),
      totalUsdt: r.totalUsdt.toFixed(8),
      spotUsdt: r.spotUsdt.toFixed(8),
      futuresUsdt: r.futuresUsdt.toFixed(8),
      breakdown: r.breakdown,
    }));
  }
}
