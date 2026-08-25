import { Injectable, HttpStatus } from '@nestjs/common';
import {
  BalanceJournalKind,
  FundingTxType,
  FuturesIncomeType,
  MarketType,
  OrderStatus,
  Prisma,
  UserRole,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { JournalWriter, SourceKey } from '@app/core-domain/ledger/journal-writer';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { TwoFactorService } from '@app/core-domain/two-factor/two-factor.service';
import { AdjustBalanceDto } from './dto/adjust-balance.dto';
import { UpdateFeeDto } from './dto/update-fee.dto';
import { UpdateFeeTierDto } from './dto/update-fee-tier.dto';
import { SetRoleDto } from './dto/set-role.dto';
import { SetRestrictionsDto } from './dto/set-restrictions.dto';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const OPEN_ORDER_STATUSES: OrderStatus[] = [OrderStatus.NEW, OrderStatus.OPEN, OrderStatus.PARTIAL];
const ZERO = new Decimal(0);
// seed의 보험기금 시스템 유저와 동일해야 한다
const INSURANCE_FUND_EMAIL = 'insurance-fund@bitshuriken.internal';
const DAY_MS = 24 * 60 * 60 * 1000;

type AdjustDirection = 'credit' | 'debit';

export interface UserListQuery {
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * Admin 오버사이트 read + 비-엔진 write 서비스. 임의 유저를 target으로 조회(self-scope 규칙 예외).
 * 민감 값(secretEncrypted, twoFactorSecret, hashedPassword)은 절대 select하지 않는다.
 * 잔고 mutation은 매칭엔진을 거치지 않음 — 엔진은 주문 mutation만 소유. raw Wallet 갱신 금지(FundingTx 원장 동반).
 */
@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private twoFactor: TwoFactorService,
    private journal: JournalWriter,
  ) {}

  async listUsers(q: UserListQuery) {
    const limit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(q.offset ?? 0, 0);
    const where: Prisma.UserWhereInput = q.search
      ? { email: { contains: q.search, mode: 'insensitive' } }
      : {};

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        select: {
          id: true,
          email: true,
          displayName: true,
          role: true,
          emailVerified: true,
          twoFactorEnabled: true,
          loginEnabled: true,
          tradingEnabled: true,
          withdrawalEnabled: true,
          feeMakerBps: true,
          feeTakerBps: true,
          feeTier: true,
          createdAt: true,
          _count: { select: { orders: true, apiKeys: true, positions: true } },
        },
      }),
    ]);

    return {
      total,
      limit,
      offset,
      users: rows.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        role: u.role,
        emailVerified: u.emailVerified,
        twoFactorEnabled: u.twoFactorEnabled,
        restricted: !(u.loginEnabled && u.tradingEnabled && u.withdrawalEnabled),
        feeMakerBps: u.feeMakerBps,
        feeTakerBps: u.feeTakerBps,
        feeTier: u.feeTier,
        orderCount: u._count.orders,
        apiKeyCount: u._count.apiKeys,
        positionCount: u._count.positions,
        createdAt: u.createdAt.getTime(),
      })),
    };
  }

  async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        emailVerified: true,
        twoFactorEnabled: true,
        loginEnabled: true,
        tradingEnabled: true,
        withdrawalEnabled: true,
        feeMakerBps: true,
        feeTakerBps: true,
        feeTier: true,
        createdAt: true,
      },
    });
    if (!user)
      throw new DomainException(ErrorCode.USER_NOT_FOUND, 'User not found', HttpStatus.NOT_FOUND);

    const [wallets, positions, openOrders, recentTxs, apiKeys] = await Promise.all([
      this.prisma.wallet.findMany({
        where: { userId },
        orderBy: [{ marketType: 'asc' }, { assetSymbol: 'asc' }],
      }),
      this.prisma.position.findMany({ where: { userId, qty: { not: 0 } } }),
      this.prisma.order.findMany({
        where: { userId, status: { in: OPEN_ORDER_STATUSES } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.fundingTx.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.apiKey.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          apiKey: true,
          label: true,
          canTrade: true,
          canRead: true,
          createdAt: true,
          lastUsedAt: true,
          revokedAt: true,
        },
      }),
    ]);

    return {
      user: { ...user, createdAt: user.createdAt.getTime() },
      wallets: wallets.map((w) => ({
        assetSymbol: w.assetSymbol,
        marketType: w.marketType,
        balance: w.balance.toFixed(8),
        locked: w.locked.toFixed(8),
      })),
      positions: positions.map((p) => ({
        tickerSymbol: p.tickerSymbol,
        qty: p.qty.toFixed(8),
        entryPrice: p.entryPrice.toFixed(8),
        isolatedMargin: p.isolatedMargin.toFixed(8),
        leverage: p.leverage,
        marginMode: p.marginMode,
        status: p.status,
      })),
      openOrders: openOrders.map((o) => ({
        id: o.id,
        tickerSymbol: o.tickerSymbol,
        tickerMarket: o.tickerMarket,
        type: o.type,
        side: o.side,
        price: o.price?.toFixed(8) ?? null,
        origQty: o.origQty?.toFixed(8) ?? null,
        executedQty: o.executedQty.toFixed(8),
        status: o.status,
        createdAt: o.createdAt.getTime(),
      })),
      recentTransactions: recentTxs.map((t) => ({
        id: t.id,
        type: t.type,
        assetSymbol: t.assetSymbol,
        qty: t.qty.toFixed(8),
        fromMarket: t.fromMarket,
        toMarket: t.toMarket,
        status: t.status,
        reason: t.reason,
        time: t.createdAt.getTime(),
      })),
      apiKeys: apiKeys.map((k) => ({
        id: k.id,
        apiKey: k.apiKey,
        label: k.label,
        canTrade: k.canTrade,
        canRead: k.canRead,
        createdAt: k.createdAt.getTime(),
        lastUsedAt: k.lastUsedAt?.getTime() ?? null,
        revokedAt: k.revokedAt?.getTime() ?? null,
      })),
    };
  }

  // ---- mutations (acting admin에 2FA step-up) ----

  /** 수동 잔고 가감. 엔진 미경유 — Wallet upsert/조건부 차감 + FundingTx(ADJUSTMENT) 원장을 한 트랜잭션으로. */
  async adjustBalance(
    adminId: string,
    targetUserId: string,
    dto: AdjustBalanceDto,
    direction: AdjustDirection,
  ) {
    await this.twoFactor.assertSatisfied(adminId, dto.totpCode);
    await this.assertUserExists(targetUserId);
    await this.assertAssetExists(dto.assetSymbol);
    const qty = this.parseQty(dto.qty);
    const market = dto.marketType;

    const ledger = await this.prisma.$transaction(async (tx) => {
      if (direction === 'credit') {
        await tx.wallet.upsert({
          where: {
            userId_assetSymbol_marketType: {
              userId: targetUserId,
              assetSymbol: dto.assetSymbol,
              marketType: market,
            },
          },
          create: {
            userId: targetUserId,
            assetSymbol: dto.assetSymbol,
            marketType: market,
            balance: qty,
          },
          update: { balance: { increment: qty } },
        });
      } else {
        // 원자적 조건부 차감 — 음수 잔고 방지
        const debit = await tx.wallet.updateMany({
          where: {
            userId: targetUserId,
            assetSymbol: dto.assetSymbol,
            marketType: market,
            balance: { gte: qty },
          },
          data: { balance: { decrement: qty } },
        });
        if (debit.count === 0)
          throw new DomainException(ErrorCode.INSUFFICIENT_BALANCE, 'Insufficient balance');
      }

      const fundingTx = await tx.fundingTx.create({
        data: {
          userId: targetUserId,
          type: FundingTxType.ADJUSTMENT,
          assetSymbol: dto.assetSymbol,
          qty,
          toMarket: direction === 'credit' ? market : null,
          fromMarket: direction === 'debit' ? market : null,
          adminId,
          reason: dto.reason ?? null,
        },
      });

      // 저널 미러 (S0 섀도) — Wallet 가감과 동일 델타 (credit +, debit −).
      await this.journal.writeInTx(tx, {
        userId: targetUserId,
        assetSymbol: dto.assetSymbol,
        marketType: market,
        kind: BalanceJournalKind.ADMIN_ADJUST,
        deltaBalance: direction === 'credit' ? qty : qty.neg(),
        deltaLocked: ZERO,
        sourceKey: SourceKey.adminAdjust(fundingTx.id),
      });

      // FUTURES 지갑 조정은 income 원장에도 반영(futures history 일관성) — transfers와 동형
      if (market === MarketType.FUTURES) {
        await tx.futuresIncome.create({
          data: {
            userId: targetUserId,
            incomeType: FuturesIncomeType.TRANSFER,
            income: direction === 'credit' ? qty : qty.neg(),
            sourceKey: `adjust:${fundingTx.id}`,
          },
        });
      }

      return fundingTx;
    });

    return {
      adjustmentId: ledger.id,
      direction,
      marketType: market,
      assetSymbol: dto.assetSymbol,
      qty: qty.toFixed(8),
    };
  }

  /** deprecated — 레거시 bps 컬럼(표시 전용) 수정. 정산은 feeTier 기준 (ADR-073). */
  async updateFee(adminId: string, targetUserId: string, dto: UpdateFeeDto) {
    await this.twoFactor.assertSatisfied(adminId, dto.totpCode);
    await this.assertUserExists(targetUserId);
    const user = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { feeMakerBps: dto.feeMakerBps, feeTakerBps: dto.feeTakerBps },
      select: { id: true, feeMakerBps: true, feeTakerBps: true },
    });
    return { userId: user.id, feeMakerBps: user.feeMakerBps, feeTakerBps: user.feeTakerBps };
  }

  /** 수수료 티어 지정 — 요율은 코드 테이블(fee-tiers.ts). 범위는 DTO 검증, 전파 ≤60s 캐시. */
  async updateFeeTier(adminId: string, targetUserId: string, dto: UpdateFeeTierDto) {
    await this.twoFactor.assertSatisfied(adminId, dto.totpCode);
    await this.assertUserExists(targetUserId);
    const user = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { feeTier: dto.feeTier },
      select: { id: true, feeTier: true },
    });
    return { userId: user.id, feeTier: user.feeTier };
  }

  /** API key soft-delete(revokedAt). 멱등. secret은 노출하지 않음. */
  async revokeApiKey(adminId: string, apiKeyId: string, totpCode?: string) {
    await this.twoFactor.assertSatisfied(adminId, totpCode);
    const key = await this.prisma.apiKey.findUnique({
      where: { id: apiKeyId },
      select: { id: true, revokedAt: true },
    });
    if (!key)
      throw new DomainException(
        ErrorCode.API_KEY_NOT_FOUND,
        'API key not found',
        HttpStatus.NOT_FOUND,
      );
    if (key.revokedAt) return { id: key.id, revokedAt: key.revokedAt.getTime() };
    const updated = await this.prisma.apiKey.update({
      where: { id: apiKeyId },
      data: { revokedAt: new Date() },
      select: { revokedAt: true },
    });
    const revokedAt = updated.revokedAt ?? new Date();
    return { id: apiKeyId, revokedAt: revokedAt.getTime() };
  }

  // ---- account actions (2FA step-up) ----

  /** role 승격/강등. 본인 admin 강등은 차단(잠금 회피). */
  async setRole(adminId: string, targetUserId: string, dto: SetRoleDto) {
    await this.twoFactor.assertSatisfied(adminId, dto.totpCode);
    if (targetUserId === adminId && dto.role !== UserRole.ADMIN)
      throw new DomainException(
        ErrorCode.INVALID_PARAMETER,
        'You cannot remove your own admin role',
        HttpStatus.BAD_REQUEST,
      );
    await this.assertUserExists(targetUserId);
    const user = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { role: dto.role },
      select: { id: true, role: true },
    });
    return { userId: user.id, role: user.role };
  }

  /** 유저 2FA 강제 해제 (분실/잠금 지원). */
  async resetTwoFactor(adminId: string, targetUserId: string, totpCode?: string) {
    await this.twoFactor.assertSatisfied(adminId, totpCode);
    await this.assertUserExists(targetUserId);
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { twoFactorEnabled: false, twoFactorSecret: null },
    });
    return { userId: targetUserId, twoFactorEnabled: false };
  }

  /** 이메일 강제 인증. */
  async forceVerifyEmail(adminId: string, targetUserId: string, totpCode?: string) {
    await this.twoFactor.assertSatisfied(adminId, totpCode);
    await this.assertUserExists(targetUserId);
    await this.prisma.user.update({
      where: { id: targetUserId },
      data: { emailVerified: true },
    });
    return { userId: targetUserId, emailVerified: true };
  }

  /** 계정 제한(로그인/거래/출금) 개별 토글. 미지정 필드는 변경 없음. 게이트는 DB 라이브라 즉시 효력. */
  async setRestrictions(adminId: string, targetUserId: string, dto: SetRestrictionsDto) {
    await this.twoFactor.assertSatisfied(adminId, dto.totpCode);
    await this.assertUserExists(targetUserId);
    const data: Prisma.UserUpdateInput = {};
    if (dto.loginEnabled !== undefined) data.loginEnabled = dto.loginEnabled;
    if (dto.tradingEnabled !== undefined) data.tradingEnabled = dto.tradingEnabled;
    if (dto.withdrawalEnabled !== undefined) data.withdrawalEnabled = dto.withdrawalEnabled;
    const user = await this.prisma.user.update({
      where: { id: targetUserId },
      data,
      select: { id: true, loginEnabled: true, tradingEnabled: true, withdrawalEnabled: true },
    });
    return {
      userId: user.id,
      loginEnabled: user.loginEnabled,
      tradingEnabled: user.tradingEnabled,
      withdrawalEnabled: user.withdrawalEnabled,
    };
  }

  /** 레이트리밋 면제 토글 (시장 조성 계정). service(X-Admin-Secret) 또는 세션 admin. */
  async setRateLimitExempt(targetUserId: string, exempt: boolean) {
    await this.assertUserExists(targetUserId);
    const user = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { rateLimitExempt: exempt },
      select: { id: true, rateLimitExempt: true },
    });
    return { userId: user.id, rateLimitExempt: user.rateLimitExempt };
  }

  // ---- platform overview (dashboard) ----

  /** 플랫폼 재무/통계 집계 (read-only). 금액은 fixed-8, time은 epoch ms. */
  async getOverview() {
    const now = Date.now();
    const dayAgo = new Date(now - DAY_MS);
    const weekAgo = new Date(now - 7 * DAY_MS);

    const [
      totalUsers,
      adminUsers,
      restrictedUsers,
      newUsers24h,
      newUsers7d,
      tickerStatusGroups,
      openOrders,
      openPositions,
      totalTrades,
      walletGroups,
      makerComm,
      takerComm,
      insuranceWallet,
      recentAdjustments,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { role: UserRole.ADMIN } }),
      this.prisma.user.count({
        where: {
          OR: [{ loginEnabled: false }, { tradingEnabled: false }, { withdrawalEnabled: false }],
        },
      }),
      this.prisma.user.count({ where: { createdAt: { gte: dayAgo } } }),
      this.prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
      this.prisma.ticker.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.order.count({ where: { status: { in: OPEN_ORDER_STATUSES } } }),
      this.prisma.position.count({ where: { qty: { not: 0 } } }),
      this.prisma.trade.count(),
      this.prisma.wallet.groupBy({ by: ['assetSymbol'], _sum: { balance: true, locked: true } }),
      this.prisma.trade.groupBy({ by: ['makerCommissionAsset'], _sum: { makerCommission: true } }),
      this.prisma.trade.groupBy({ by: ['takerCommissionAsset'], _sum: { takerCommission: true } }),
      this.prisma.wallet.findFirst({
        where: {
          assetSymbol: 'USDT',
          marketType: MarketType.FUTURES,
          user: { email: INSURANCE_FUND_EMAIL },
        },
        select: { balance: true },
      }),
      this.prisma.fundingTx.findMany({
        where: { type: FundingTxType.ADJUSTMENT },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    const tickersByStatus: Record<string, number> = {};
    for (const g of tickerStatusGroups) tickersByStatus[g.status] = g._count._all;
    const totalTickers = tickerStatusGroups.reduce((n, g) => n + g._count._all, 0);

    // 자산별 플랫폼 보유 (balance + locked), 값 내림차순
    const balancesByAsset = walletGroups
      .map((g) => ({
        asset: g.assetSymbol,
        total: (g._sum.balance ?? ZERO).add(g._sum.locked ?? ZERO),
      }))
      .filter((b) => b.total.gt(0))
      .sort((a, b) => b.total.cmp(a.total))
      .map((b) => ({ asset: b.asset, total: b.total.toFixed(8) }));

    // 수수료 수익 (maker + taker, 자산별)
    const feeMap = new Map<string, Decimal>();
    for (const g of makerComm) {
      if (!g.makerCommissionAsset) continue;
      feeMap.set(
        g.makerCommissionAsset,
        (feeMap.get(g.makerCommissionAsset) ?? ZERO).add(g._sum.makerCommission ?? ZERO),
      );
    }
    for (const g of takerComm) {
      if (!g.takerCommissionAsset) continue;
      feeMap.set(
        g.takerCommissionAsset,
        (feeMap.get(g.takerCommissionAsset) ?? ZERO).add(g._sum.takerCommission ?? ZERO),
      );
    }
    const feeRevenueByAsset = [...feeMap.entries()]
      .filter(([, v]) => v.gt(0))
      .sort((a, b) => b[1].cmp(a[1]))
      .map(([asset, v]) => ({ asset, total: v.toFixed(8) }));

    return {
      users: {
        total: totalUsers,
        admins: adminUsers,
        restricted: restrictedUsers,
        new24h: newUsers24h,
        new7d: newUsers7d,
      },
      markets: { total: totalTickers, byStatus: tickersByStatus },
      activity: { openOrders, openPositions, totalTrades },
      financials: {
        balancesByAsset,
        feeRevenueByAsset,
        insuranceFundUsdt: (insuranceWallet?.balance ?? ZERO).toFixed(8),
      },
      recentAdjustments: recentAdjustments.map((t) => ({
        id: t.id,
        userId: t.userId,
        assetSymbol: t.assetSymbol,
        qty: t.qty.toFixed(8),
        direction: t.toMarket ? 'credit' : 'debit',
        reason: t.reason,
        time: t.createdAt.getTime(),
      })),
    };
  }

  // ---- helpers ----

  private parseQty(raw: string): Decimal {
    const qty = new Decimal(raw);
    if (!qty.isFinite() || qty.lte(0))
      throw new DomainException(ErrorCode.INVALID_QTY, 'qty must be positive');
    if (qty.decimalPlaces() > 8)
      throw new DomainException(ErrorCode.INVALID_QTY, 'qty must have at most 8 decimal places');
    return qty;
  }

  private async assertUserExists(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user)
      throw new DomainException(ErrorCode.USER_NOT_FOUND, 'User not found', HttpStatus.NOT_FOUND);
  }

  private async assertAssetExists(assetSymbol: string): Promise<void> {
    const asset = await this.prisma.asset.findUnique({ where: { symbol: assetSymbol } });
    if (!asset)
      throw new DomainException(ErrorCode.INVALID_PARAMETER, `Unknown asset: ${assetSymbol}`);
  }
}
