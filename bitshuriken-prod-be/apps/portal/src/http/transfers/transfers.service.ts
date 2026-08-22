import { Injectable } from '@nestjs/common';
import {
  BalanceJournalKind,
  FundingTxType,
  FuturesIncomeType,
  MarketType,
  PositionStatus,
  Prisma,
  SettlementKind,
  SettlementStatus,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { JournalWriter, SourceKey } from '@app/core-domain/ledger/journal-writer';
import { CreateTransferDto } from './dto/create-transfer.dto';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

// futures 전용 worker가 적용하는 kind — PENDING이면 futures 잔고 미확정
const FUTURES_KINDS: SettlementKind[] = [
  SettlementKind.FUTURES_TRADE,
  SettlementKind.FUTURES_REFUND,
  SettlementKind.FUNDING,
  SettlementKind.LIQUIDATION_TAKEOVER,
];

@Injectable()
export class TransfersService {
  constructor(
    private prisma: PrismaService,
    private journal: JournalWriter,
  ) {}

  async transfer(userId: string, dto: CreateTransferDto) {
    if (dto.fromMarket === dto.toMarket) {
      throw new DomainException(ErrorCode.INVALID_PARAMETER, 'fromMarket and toMarket must differ');
    }
    const qty = new Decimal(dto.qty);
    if (!qty.isFinite() || qty.lte(0)) {
      throw new DomainException(ErrorCode.INVALID_QTY, 'qty must be positive');
    }
    if (qty.decimalPlaces() > 8) {
      throw new DomainException(ErrorCode.INVALID_QTY, 'qty must have at most 8 decimal places');
    }

    // FuturesIncome는 futures leg가 있는 이체만 기록 — 가짜 income 방지
    const involvesFutures =
      dto.fromMarket === MarketType.FUTURES || dto.toMarket === MarketType.FUTURES;
    // futures 계정 기준 부호: 입금 +, 출금 −
    const income = dto.toMarket === MarketType.FUTURES ? qty : qty.neg();

    const ledger = await this.prisma.$transaction(async (tx) => {
      // 원자적 조건부 차감 — check-then-update는 동시 요청에서 초과 인출 가능
      const debit = await tx.wallet.updateMany({
        where: {
          userId,
          assetSymbol: dto.assetSymbol,
          marketType: dto.fromMarket,
          balance: { gte: qty },
        },
        data: { balance: { decrement: qty } },
      });
      if (debit.count === 0) {
        throw new DomainException(ErrorCode.INSUFFICIENT_BALANCE, 'Insufficient balance');
      }

      // 게이트는 차감으로 wallet 행을 잠근 뒤 같은 tx에서 — 게이트와 commit 사이 정산 consume 레이스 차단
      if (dto.fromMarket === MarketType.FUTURES) {
        await this.assertFuturesWithdrawable(tx, userId);
      }

      await tx.wallet.upsert({
        where: {
          userId_assetSymbol_marketType: {
            userId,
            assetSymbol: dto.assetSymbol,
            marketType: dto.toMarket,
          },
        },
        create: {
          userId,
          assetSymbol: dto.assetSymbol,
          marketType: dto.toMarket,
          balance: qty,
        },
        update: { balance: { increment: qty } },
      });

      const fundingTx = await tx.fundingTx.create({
        data: {
          userId,
          type: FundingTxType.TRANSFER,
          assetSymbol: dto.assetSymbol,
          qty,
          fromMarket: dto.fromMarket,
          toMarket: dto.toMarket,
        },
      });

      if (involvesFutures) {
        await tx.futuresIncome.create({
          data: {
            userId,
            incomeType: FuturesIncomeType.TRANSFER,
            income,
            sourceKey: `transfer:${fundingTx.id}`,
          },
        });
      }

      // 저널 미러 (S0 섀도): 양 leg를 각 마켓으로 1건씩 — 소유 앱 tailer가 각자 적용. Wallet 델타와 동일.
      await this.journal.writeManyInTx(tx, [
        {
          userId,
          assetSymbol: dto.assetSymbol,
          marketType: dto.fromMarket,
          kind: BalanceJournalKind.TRANSFER,
          deltaBalance: qty.neg(),
          deltaLocked: new Decimal(0),
          sourceKey: SourceKey.transferOut(fundingTx.id),
        },
        {
          userId,
          assetSymbol: dto.assetSymbol,
          marketType: dto.toMarket,
          kind: BalanceJournalKind.TRANSFER,
          deltaBalance: qty,
          deltaLocked: new Decimal(0),
          sourceKey: SourceKey.transferIn(fundingTx.id),
        },
      ]);

      return fundingTx;
    });

    return {
      transferId: ledger.id,
      fromMarket: dto.fromMarket,
      toMarket: dto.toMarket,
      assetSymbol: dto.assetSymbol,
      qty: qty.toFixed(8),
    };
  }

  /** futures 출금 가드: PENDING futures 정산 또는 청산 중 포지션이 있으면 거부 (throw → 차감 롤백). */
  private async assertFuturesWithdrawable(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    const liquidating = await tx.position.findFirst({
      where: { userId, status: PositionStatus.LIQUIDATING },
      select: { tickerSymbol: true },
    });
    if (liquidating) {
      throw new DomainException(
        ErrorCode.POSITION_LIQUIDATING,
        'Transfer rejected: position is liquidating',
      );
    }

    // PENDING은 소량 — legs JSON을 JS에서 필터 (kind별 raw 형태가 달라 user 필드 3종 모두 검사)
    const pending = await tx.settlementEvent.findMany({
      where: { status: SettlementStatus.PENDING, kind: { in: FUTURES_KINDS } },
      select: { legs: true },
    });
    const involvesUser = pending.some(
      (event) =>
        Array.isArray(event.legs) &&
        event.legs.some((raw) => {
          const leg = raw as Record<string, unknown> | null;
          return (
            leg !== null &&
            typeof leg === 'object' &&
            (leg.userId === userId || leg.makerUserId === userId || leg.takerUserId === userId)
          );
        }),
    );
    if (involvesUser) {
      throw new DomainException(
        ErrorCode.TRANSFER_PENDING_SETTLEMENT,
        'Transfer rejected: pending futures settlement',
      );
    }
  }

}
