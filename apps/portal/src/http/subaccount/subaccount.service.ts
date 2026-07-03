import { Injectable, HttpStatus } from '@nestjs/common';
import {
  FundingTxType,
  FuturesIncomeType,
  MarketType,
  PositionStatus,
  Prisma,
  SettlementKind,
  SettlementStatus,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { ApiKeyService } from '@app/core-domain/api-key/api-key.service';
import { TwoFactorService } from '@app/core-domain/two-factor/two-factor.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { CreateSubaccountDto } from './dto/create-subaccount.dto';
import { SubaccountTransferDto } from './dto/subaccount-transfer.dto';

const MAX_SUBACCOUNTS = 100;

// futures 정산을 적용하는 worker kind — PENDING이면 futures 잔고 미확정 (transfers.service와 동일 가드)
const FUTURES_KINDS: SettlementKind[] = [
  SettlementKind.FUTURES_TRADE,
  SettlementKind.FUTURES_REFUND,
  SettlementKind.FUNDING,
  SettlementKind.LIQUIDATION_TAKEOVER,
];

interface CreateApiKeyParams {
  label?: string;
  canTrade?: boolean;
  canRead?: boolean;
  totpCode?: string;
}

/**
 * 서브계정 관리 — 마스터 세션(JWT)으로만 호출. 서브계정은 별도 User 행(parentUserId=마스터),
 * 로그인 자격 없이 API 키로만 거래한다. 키로 인증하면 userId=서브 id가 되어 지갑/주문이 자동 격리된다.
 */
@Injectable()
export class SubaccountService {
  constructor(
    private prisma: PrismaService,
    private apiKeyService: ApiKeyService,
    private twoFactor: TwoFactorService,
  ) {}

  /** 서브계정 생성. 마스터의 수수료율을 상속. 합성 email + 사용 불가 password(로그인 차단). */
  async create(masterUserId: string, dto: CreateSubaccountDto) {
    const master = await this.assertMaster(masterUserId);

    const count = await this.prisma.user.count({ where: { parentUserId: masterUserId } });
    if (count >= MAX_SUBACCOUNTS) {
      throw new DomainException(
        ErrorCode.SUBACCOUNT_LIMIT_REACHED,
        `Maximum of ${MAX_SUBACCOUNTS} subaccounts reached`,
      );
    }

    // 로그인 불가: 합성 email + 아무도 모르는 무작위 비밀번호 해시 (bcrypt.compare는 항상 실패)
    const email = `sub.${crypto.randomBytes(12).toString('hex')}@subaccount.local`;
    const hashedPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

    const sub = await this.prisma.user.create({
      data: {
        email,
        hashedPassword,
        displayName: dto.label ?? null,
        parentUserId: masterUserId,
        feeMakerBps: master.feeMakerBps,
        feeTakerBps: master.feeTakerBps,
      },
      select: { id: true, displayName: true, feeMakerBps: true, feeTakerBps: true, createdAt: true },
    });

    return {
      id: sub.id,
      label: sub.displayName,
      feeMakerBps: sub.feeMakerBps,
      feeTakerBps: sub.feeTakerBps,
      createdAt: sub.createdAt,
    };
  }

  /** 마스터의 서브계정 목록 (최신순). */
  async list(masterUserId: string) {
    const subs = await this.prisma.user.findMany({
      where: { parentUserId: masterUserId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, displayName: true, feeMakerBps: true, feeTakerBps: true, createdAt: true },
    });
    return subs.map((s) => ({
      id: s.id,
      label: s.displayName,
      feeMakerBps: s.feeMakerBps,
      feeTakerBps: s.feeTakerBps,
      createdAt: s.createdAt,
    }));
  }

  /** 서브계정 지갑 잔고 — 마스터가 소유한 서브만 조회 가능. */
  async getBalances(masterUserId: string, subaccountId: string) {
    await this.assertOwned(masterUserId, subaccountId);
    const wallets = await this.prisma.wallet.findMany({
      where: { userId: subaccountId },
      select: { assetSymbol: true, marketType: true, balance: true, locked: true },
    });
    return wallets.map((w) => ({
      assetSymbol: w.assetSymbol,
      marketType: w.marketType,
      balance: w.balance.toFixed(8),
      locked: w.locked.toFixed(8),
    }));
  }

  /** 서브계정용 API 키 발급. 마스터의 2FA로 보호(서브는 2FA 없음). */
  async issueApiKey(masterUserId: string, subaccountId: string, params: CreateApiKeyParams) {
    await this.assertOwned(masterUserId, subaccountId);
    await this.twoFactor.assertSatisfied(masterUserId, params.totpCode);
    // 키는 서브계정 소유 → 이 키로 인증하면 userId=서브 id로 격리 동작
    return this.apiKeyService.issue(subaccountId, { ...params, totpCode: undefined });
  }

  async listApiKeys(masterUserId: string, subaccountId: string) {
    await this.assertOwned(masterUserId, subaccountId);
    return this.apiKeyService.listForUser(subaccountId);
  }

  async revokeApiKey(masterUserId: string, subaccountId: string, apiKeyId: string) {
    await this.assertOwned(masterUserId, subaccountId);
    await this.apiKeyService.revoke(subaccountId, apiKeyId);
  }

  /**
   * 계정 간 이체 — 마스터↔서브 / 서브↔서브. 양측 모두 같은 마스터 소속이어야 함.
   * 같은 마켓(SPOT 기본) 내 이동. FUTURES면 보낸 쪽에 출금 게이트 적용.
   */
  async transfer(masterUserId: string, dto: SubaccountTransferDto) {
    const market = dto.market ?? MarketType.SPOT;
    if (dto.fromAccountId === dto.toAccountId) {
      throw new DomainException(ErrorCode.INVALID_PARAMETER, 'fromAccountId and toAccountId must differ');
    }
    await this.assertAccountInFamily(masterUserId, dto.fromAccountId);
    await this.assertAccountInFamily(masterUserId, dto.toAccountId);

    const qty = this.parseQty(dto.qty);

    const ledger = await this.prisma.$transaction(async (tx) => {
      // 원자적 조건부 차감 — check-then-update는 동시 요청에서 초과 인출 가능
      const debit = await tx.wallet.updateMany({
        where: {
          userId: dto.fromAccountId,
          assetSymbol: dto.assetSymbol,
          marketType: market,
          balance: { gte: qty },
        },
        data: { balance: { decrement: qty } },
      });
      if (debit.count === 0) {
        throw new DomainException(ErrorCode.INSUFFICIENT_BALANCE, 'Insufficient balance');
      }

      // 차감으로 wallet 행을 잠근 뒤 같은 tx에서 게이트 — 게이트와 commit 사이 정산 레이스 차단
      if (market === MarketType.FUTURES) {
        await this.assertFuturesWithdrawable(tx, dto.fromAccountId);
      }

      await tx.wallet.upsert({
        where: {
          userId_assetSymbol_marketType: {
            userId: dto.toAccountId,
            assetSymbol: dto.assetSymbol,
            marketType: market,
          },
        },
        create: {
          userId: dto.toAccountId,
          assetSymbol: dto.assetSymbol,
          marketType: market,
          balance: qty,
        },
        update: { balance: { increment: qty } },
      });

      // 양측 원장 — 보낸 쪽 fromMarket만, 받은 쪽 toMarket만 (방향 표시)
      const out = await tx.fundingTx.create({
        data: {
          userId: dto.fromAccountId,
          type: FundingTxType.SUBACCOUNT_TRANSFER,
          assetSymbol: dto.assetSymbol,
          qty,
          fromMarket: market,
          counterpartyUserId: dto.toAccountId,
        },
      });
      const inc = await tx.fundingTx.create({
        data: {
          userId: dto.toAccountId,
          type: FundingTxType.SUBACCOUNT_TRANSFER,
          assetSymbol: dto.assetSymbol,
          qty,
          toMarket: market,
          counterpartyUserId: dto.fromAccountId,
        },
      });

      // FUTURES면 양측 수익 원장(TRANSFER)도 — futures 지갑 변동 표시 (보낸 −, 받은 +)
      if (market === MarketType.FUTURES) {
        await tx.futuresIncome.createMany({
          data: [
            {
              userId: dto.fromAccountId,
              incomeType: FuturesIncomeType.TRANSFER,
              income: qty.neg(),
              sourceKey: `subtransfer:${out.id}`,
            },
            {
              userId: dto.toAccountId,
              incomeType: FuturesIncomeType.TRANSFER,
              income: qty,
              sourceKey: `subtransfer:${inc.id}`,
            },
          ],
        });
      }

      return out;
    });

    return {
      transferId: ledger.id,
      fromAccountId: dto.fromAccountId,
      toAccountId: dto.toAccountId,
      assetSymbol: dto.assetSymbol,
      market,
      qty: qty.toFixed(8),
    };
  }

  /** 호출자가 마스터(서브가 아님)인지 확인하고 레코드 반환. */
  private async assertMaster(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, parentUserId: true, feeMakerBps: true, feeTakerBps: true },
    });
    if (!user) {
      throw new DomainException(ErrorCode.USER_NOT_FOUND, 'User not found', HttpStatus.NOT_FOUND);
    }
    if (user.parentUserId !== null) {
      throw new DomainException(
        ErrorCode.SUBACCOUNT_NESTING_FORBIDDEN,
        'A subaccount cannot own subaccounts',
        HttpStatus.FORBIDDEN,
      );
    }
    return user;
  }

  /** subaccountId가 masterUserId 소유의 서브계정인지 확인. 아니면 not found(존재 노출 방지). */
  private async assertOwned(masterUserId: string, subaccountId: string) {
    const sub = await this.prisma.user.findUnique({
      where: { id: subaccountId },
      select: { id: true, parentUserId: true },
    });
    if (!sub || sub.parentUserId !== masterUserId) {
      throw new DomainException(
        ErrorCode.SUBACCOUNT_NOT_FOUND,
        'Subaccount not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return sub;
  }

  /** accountId가 마스터 본인이거나 그가 소유한 서브계정인지 확인. */
  private async assertAccountInFamily(masterUserId: string, accountId: string): Promise<void> {
    if (accountId === masterUserId) return;
    await this.assertOwned(masterUserId, accountId);
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
