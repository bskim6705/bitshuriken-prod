import { Injectable } from '@nestjs/common';
import { FundingTxType, Prisma } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export interface TransactionQuery {
  type?: string;
  asset?: string;
  limit?: number;
  endTime?: number;
}

/** 입금/출금/내부이체 원장 조회 — 사람이 보는 값은 fixed-8, time은 epoch ms. */
@Injectable()
export class HistoryService {
  constructor(private prisma: PrismaService) {}

  async listTransactions(userId: string, q: TransactionQuery) {
    const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    const where: Prisma.FundingTxWhereInput = { userId };
    if (q.type !== undefined) {
      if (!(Object.values(FundingTxType) as string[]).includes(q.type)) {
        throw new DomainException(ErrorCode.INVALID_PARAMETER, `Invalid type: ${q.type}`);
      }
      where.type = q.type as FundingTxType;
    }
    if (q.asset) where.assetSymbol = q.asset;
    if (q.endTime !== undefined) where.createdAt = { lte: new Date(q.endTime) };

    const rows = await this.prisma.fundingTx.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      assetSymbol: r.assetSymbol,
      qty: r.qty.toFixed(8),
      fromMarket: r.fromMarket,
      toMarket: r.toMarket,
      counterpartyUserId: r.counterpartyUserId,
      status: r.status,
      time: r.createdAt.getTime(),
    }));
  }
}
