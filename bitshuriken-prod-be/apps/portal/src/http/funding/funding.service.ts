import { Injectable, HttpStatus } from '@nestjs/common';
import { BalanceJournalKind, FundingTxType, MarketType } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { JournalWriter, SourceKey } from '@app/core-domain/ledger/journal-writer';
import { FundingDto } from './dto/funding.dto';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { TwoFactorService } from '@app/core-domain/two-factor/two-factor.service';

/**
 * 입출금 — 외부 체인 없이 SPOT 지갑에 즉시 가산/차감하는 dev 구현.
 * pending 상태 없음. 출금은 잔고(free) 한도 내에서만.
 */
@Injectable()
export class FundingService {
  constructor(
    private prisma: PrismaService,
    private twoFactor: TwoFactorService,
    private journal: JournalWriter,
  ) {}

  async deposit(userId: string, dto: FundingDto) {
    const qty = this.parseQty(dto.qty);
    await this.assertAssetExists(dto.assetSymbol);

    // 가산과 원장 기록을 한 트랜잭션으로 — 둘 중 하나만 남는 상태 방지
    const ledger = await this.prisma.$transaction(async (tx) => {
      await tx.wallet.upsert({
        where: {
          userId_assetSymbol_marketType: {
            userId,
            assetSymbol: dto.assetSymbol,
            marketType: MarketType.SPOT,
          },
        },
        create: {
          userId,
          assetSymbol: dto.assetSymbol,
          marketType: MarketType.SPOT,
          balance: qty,
        },
        update: { balance: { increment: qty } },
      });
      const fundingTx = await tx.fundingTx.create({
        data: {
          userId,
          type: FundingTxType.DEPOSIT,
          assetSymbol: dto.assetSymbol,
          qty,
          toMarket: MarketType.SPOT,
        },
      });
      // 저널 미러 (S0 섀도) — Wallet 가산과 동일 델타.
      await this.journal.writeInTx(tx, {
        userId,
        assetSymbol: dto.assetSymbol,
        marketType: MarketType.SPOT,
        kind: BalanceJournalKind.DEPOSIT,
        deltaBalance: qty,
        deltaLocked: new Decimal(0),
        sourceKey: SourceKey.deposit(fundingTx.id),
      });
      return fundingTx;
    });

    return {
      depositId: ledger.id,
      assetSymbol: dto.assetSymbol,
      qty: qty.toFixed(8),
      marketType: MarketType.SPOT,
    };
  }

  async withdraw(userId: string, dto: FundingDto) {
    const qty = this.parseQty(dto.qty);
    await this.assertWithdrawAllowed(userId, dto.totpCode);

    const ledger = await this.prisma.$transaction(async (tx) => {
      // 원자적 조건부 차감 — check-then-update는 동시 요청에서 초과 인출 가능
      const debit = await tx.wallet.updateMany({
        where: {
          userId,
          assetSymbol: dto.assetSymbol,
          marketType: MarketType.SPOT,
          balance: { gte: qty },
        },
        data: { balance: { decrement: qty } },
      });
      if (debit.count === 0) {
        throw new DomainException(ErrorCode.INSUFFICIENT_BALANCE, 'Insufficient balance');
      }
      const fundingTx = await tx.fundingTx.create({
        data: {
          userId,
          type: FundingTxType.WITHDRAWAL,
          assetSymbol: dto.assetSymbol,
          qty,
          fromMarket: MarketType.SPOT,
        },
      });
      // 저널 미러 (S0 섀도) — Wallet 차감과 동일 델타.
      await this.journal.writeInTx(tx, {
        userId,
        assetSymbol: dto.assetSymbol,
        marketType: MarketType.SPOT,
        kind: BalanceJournalKind.WITHDRAWAL,
        deltaBalance: qty.neg(),
        deltaLocked: new Decimal(0),
        sourceKey: SourceKey.withdrawal(fundingTx.id),
      });
      return fundingTx;
    });

    return {
      withdrawalId: ledger.id,
      assetSymbol: dto.assetSymbol,
      qty: qty.toFixed(8),
      marketType: MarketType.SPOT,
    };
  }

  /** 출금 게이트: 계정 정지 아님 + 이메일 인증 필수 + (2FA 사용 시) 유효 TOTP 코드 필수. */
  private async assertWithdrawAllowed(userId: string, totpCode?: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        emailVerified: true,
        withdrawalEnabled: true,
        twoFactorEnabled: true,
        twoFactorSecret: true,
      },
    });
    if (!user) {
      throw new DomainException(ErrorCode.USER_NOT_FOUND, 'User not found', HttpStatus.NOT_FOUND);
    }
    if (!user.withdrawalEnabled) {
      throw new DomainException(
        ErrorCode.ACCOUNT_WITHDRAWAL_DISABLED,
        'Withdrawals are disabled for this account',
        HttpStatus.FORBIDDEN,
      );
    }
    if (!user.emailVerified) {
      throw new DomainException(
        ErrorCode.EMAIL_NOT_VERIFIED,
        'Email must be verified before withdrawing',
        HttpStatus.FORBIDDEN,
      );
    }
    this.twoFactor.assertForUser(user, totpCode);
  }

  private parseQty(raw: string): Decimal {
    const qty = new Decimal(raw);
    if (!qty.isFinite() || qty.lte(0)) {
      throw new DomainException(ErrorCode.INVALID_QTY, 'qty must be positive');
    }
    if (qty.decimalPlaces() > 8) {
      throw new DomainException(ErrorCode.INVALID_QTY, 'qty must have at most 8 decimal places');
    }
    return qty;
  }

  private async assertAssetExists(assetSymbol: string): Promise<void> {
    const asset = await this.prisma.asset.findUnique({ where: { symbol: assetSymbol } });
    if (!asset) {
      throw new DomainException(ErrorCode.INVALID_PARAMETER, `Unknown asset: ${assetSymbol}`);
    }
  }
}
