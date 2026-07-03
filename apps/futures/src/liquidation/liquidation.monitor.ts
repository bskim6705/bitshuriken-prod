import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { MarginMode, PositionStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { FuturesConfigService } from '../config/futures-config.service';
import { MarkPriceEvent, MarkPriceService } from '../mark-price/mark-price.service';
import { InsuranceFundService } from '../settlement/insurance-fund.service';
import { FuturesUserEventsService } from '../user-events/futures-user-events.service';
import { maintenanceMargin, marginRatio, unrealizedPnl } from '../math/margin-math';
import { isLiquidationTarget, LiquidationExecutor } from './liquidation-executor';

export { isLiquidationTarget } from './liquidation-executor';

const ZERO = new Decimal(0);
// 청산까지 20% 이내면 사전 경고 — 알림 전용(경제 효과 없음), 운영자 조정 가능
const MARGIN_CALL_RATIO = new Decimal('0.8');

/**
 * 청산 모니터 — mark tick(1s) 구동, 캐시 없이 DB 조회로 판정.
 * ISOLATED: 포지션 단일 행 판정. CROSS: 유저 계정 단위 판정 후 전 심볼 일괄 청산.
 * NORMAL→LIQUIDATING guarded claim(+재검증) 후 시퀀스 집행은 executor 위임.
 */
@Injectable()
export class LiquidationMonitor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LiquidationMonitor.name);
  // 심볼당 동시 1건 — isolated 평가~시퀀스 전 구간 점유
  private readonly busySymbols = new Set<string>();
  // cross 유저당 동시 1건 — 계정 청산은 여러 심볼 tick에서 트리거될 수 있어 유저 단위로 직렬화
  private readonly busyCrossUsers = new Set<string>();
  // MARGIN_CALL 디바운스 — warn 밴드 진입 시 1회만. isolated `userId:symbol`, cross `userId`.
  private readonly warnedIsolated = new Set<string>();
  private readonly warnedCross = new Set<string>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    private prisma: PrismaService,
    private futuresConfig: FuturesConfigService,
    private markPrice: MarkPriceService,
    private insuranceFund: InsuranceFundService,
    private executor: LiquidationExecutor,
    private userEvents: FuturesUserEventsService,
  ) {}

  onApplicationBootstrap(): void {
    this.unsubscribe = this.markPrice.onMark((event) => this.onMark(event));
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  private onMark(event: MarkPriceEvent): void {
    if (this.busySymbols.has(event.symbol)) return; // 진행 중 — 다음 tick에 재평가
    this.busySymbols.add(event.symbol);
    void this.tick(event.symbol, event.mark)
      .catch((e) => {
        this.logger.error(`liquidation sweep failed for ${event.symbol}`, e as Error);
      })
      .finally(() => this.busySymbols.delete(event.symbol));
  }

  /** tick 1회: isolated 1건 처리 우선, 없으면 cross 계정 1건. 이후 잔존 NORMAL 경고 스캔. */
  private async tick(symbol: string, mark: Decimal): Promise<void> {
    const acted = await this.sweep(symbol, mark);
    if (!acted) await this.sweepCross(symbol);
    await this.scanMarginCalls(symbol, mark);
  }

  /**
   * MARGIN_CALL 경고 스캔 — NORMAL·qty≠0 포지션의 marginRatio가 [0.8, 1) 진입 시 1회 송출.
   * isolated는 포지션 단위, cross는 계정 단위 ratio. 청산 트리거(≥1)는 건드리지 않는다.
   */
  private async scanMarginCalls(symbol: string, mark: Decimal): Promise<void> {
    const fundUserId = await this.insuranceFund.userId();
    await this.scanIsolatedMarginCalls(symbol, mark, fundUserId);
    await this.scanCrossMarginCalls(symbol, fundUserId);
  }

  private async scanIsolatedMarginCalls(
    symbol: string,
    mark: Decimal,
    fundUserId: string,
  ): Promise<void> {
    const positions = await this.prisma.position.findMany({
      where: {
        tickerSymbol: symbol,
        status: PositionStatus.NORMAL,
        qty: { not: ZERO },
        marginMode: MarginMode.ISOLATED,
        userId: { not: fundUserId },
      },
    });

    const live = new Set<string>();
    for (const p of positions) {
      const key = `${p.userId}:${symbol}`;
      live.add(key);
      const { mmr } = await this.futuresConfig.configOf(symbol);
      const mm = maintenanceMargin(mmr, mark, p.qty);
      const upnl = unrealizedPnl(mark, p.entryPrice, p.qty);
      const ratio = marginRatio(mm, p.isolatedMargin, upnl);
      this.updateWarn(this.warnedIsolated, key, ratio, () =>
        this.userEvents.emitMarginCall(p.userId, {
          symbol,
          marginMode: MarginMode.ISOLATED,
          marginRatio: ratio!.toFixed(8),
          markPrice: mark.toFixed(8),
          ts: Date.now(),
        }),
      );
    }
    // 청산/종결로 사라진 포지션의 경고 플래그 정리
    this.pruneWarned(this.warnedIsolated, `:${symbol}`, live);
  }

  private async scanCrossMarginCalls(symbol: string, fundUserId: string): Promise<void> {
    const candidates = await this.prisma.position.findMany({
      where: {
        tickerSymbol: symbol,
        status: PositionStatus.NORMAL,
        qty: { not: ZERO },
        marginMode: MarginMode.CROSS,
        userId: { not: fundUserId },
      },
      select: { userId: true },
      distinct: ['userId'],
    });

    for (const { userId } of candidates) {
      const account = await this.crossAccountPositions(userId);
      if (account.length === 0) {
        this.warnedCross.delete(userId); // 계정 청산/종결 — 경고 플래그 정리
        continue;
      }
      const ratio = await this.executor.crossAccountRatio(userId, account);
      const mark = this.markPrice.tryGetMark(symbol);
      this.updateWarn(this.warnedCross, userId, ratio, () => {
        if (mark === null) return; // markPrice는 필수 필드 — 미형성이면 송출 보류
        this.userEvents.emitMarginCall(userId, {
          symbol,
          marginMode: MarginMode.CROSS,
          marginRatio: ratio!.toFixed(8),
          markPrice: mark.toFixed(8),
          ts: Date.now(),
        });
      });
    }
  }

  /** warn 밴드 진입(첫 [0.8,1))이면 emit+기록, 밴드 이탈(<0.8)이면 기록 해제. ≥1/null은 청산 영역 — 무변경. */
  private updateWarn(
    warned: Set<string>,
    key: string,
    ratio: Decimal | null,
    emit: () => void,
  ): void {
    if (ratio === null) return; // 분모 ≤ 0 — 즉시 청산 영역
    if (ratio.gte(1)) return; // 청산 트리거는 sweep 몫
    if (ratio.gte(MARGIN_CALL_RATIO)) {
      if (warned.has(key)) return;
      warned.add(key);
      emit();
    } else {
      warned.delete(key); // 건전 복귀
    }
  }

  /** suffix로 끝나는 warned 키 중 이번 스캔에 없던(사라진) 것 제거. */
  private pruneWarned(warned: Set<string>, suffix: string, live: Set<string>): void {
    for (const key of warned) {
      if (key.endsWith(suffix) && !live.has(key)) warned.delete(key);
    }
  }

  /**
   * ISOLATED sweep — 잔존 LIQUIDATING 재진입 1건 우선, 없으면 NORMAL 위반 1건 claim 후 집행.
   * 처리한 게 있으면 true(이번 tick은 cross로 넘어가지 않음).
   */
  async sweep(symbol: string, mark: Decimal): Promise<boolean> {
    const fundUserId = await this.insuranceFund.userId();

    // 중간 실패/재시작으로 잔존한 LIQUIDATING 재진입 (시퀀스가 멱등하게 이어서 처리)
    const stuck = await this.prisma.position.findFirst({
      where: {
        tickerSymbol: symbol,
        status: PositionStatus.LIQUIDATING,
        marginMode: MarginMode.ISOLATED,
        userId: { not: fundUserId },
      },
      orderBy: { updatedAt: 'asc' },
    });
    if (stuck) {
      await this.liquidate(stuck.userId, symbol);
      return true;
    }

    const config = await this.futuresConfig.configOf(symbol);
    const positions = await this.prisma.position.findMany({
      where: {
        tickerSymbol: symbol,
        status: PositionStatus.NORMAL,
        qty: { not: ZERO },
        marginMode: MarginMode.ISOLATED,
        userId: { not: fundUserId }, // 보험기금 포지션은 모니터 제외 (수동 운영)
      },
    });

    for (const position of positions) {
      if (!isLiquidationTarget(position, mark, config.mmr)) continue;

      // guarded claim — 1건 전이 실패는 선점자에게 양보
      const claim = await this.prisma.position.updateMany({
        where: { userId: position.userId, tickerSymbol: symbol, status: PositionStatus.NORMAL },
        data: { status: PositionStatus.LIQUIDATING },
      });
      if (claim.count !== 1) continue;

      // claim 직후 최신 행·mark로 재검증 — 판정~claim 사이 마진 추가/체결로 건전해진 포지션 보호
      const claimed = await this.executor.findPosition(position.userId, symbol);
      await this.executor.emitPosition(claimed);
      if (!isLiquidationTarget(claimed, this.markPrice.getMark(symbol), config.mmr)) {
        await this.executor.restoreNormal(position.userId, symbol);
        continue;
      }

      this.logger.warn(
        `liquidation claimed: user=${position.userId} ${symbol} qty=${claimed.qty.toFixed(8)} mark=${mark.toFixed(8)}`,
      );
      await this.liquidate(position.userId, symbol);
      return true; // 심볼당 동시 1건 — 나머지 대상은 다음 tick
    }
    return false;
  }

  /**
   * CROSS sweep — 잔존 LIQUIDATING cross 계정 재진입 우선, 없으면 이 심볼에 cross 포지션을 가진
   * 유저별로 계정 단위 판정 후 전 cross 포지션 claim → 집행.
   */
  async sweepCross(symbol: string): Promise<void> {
    const fundUserId = await this.insuranceFund.userId();

    const stuck = await this.prisma.position.findFirst({
      where: {
        tickerSymbol: symbol,
        status: PositionStatus.LIQUIDATING,
        marginMode: MarginMode.CROSS,
        userId: { not: fundUserId },
      },
      orderBy: { updatedAt: 'asc' },
    });
    if (stuck) {
      await this.runCross(stuck.userId);
      return;
    }

    const candidates = await this.prisma.position.findMany({
      where: {
        tickerSymbol: symbol,
        status: PositionStatus.NORMAL,
        qty: { not: ZERO },
        marginMode: MarginMode.CROSS,
        userId: { not: fundUserId },
      },
      select: { userId: true },
      distinct: ['userId'],
    });

    for (const { userId } of candidates) {
      if (this.busyCrossUsers.has(userId)) continue;

      const account = await this.crossAccountPositions(userId);
      if (!(await this.executor.isCrossAccountBreached(userId, account))) continue;

      // guarded claim — 유저의 qty≠0 cross 포지션 전부 전이
      const claim = await this.prisma.position.updateMany({
        where: {
          userId,
          marginMode: MarginMode.CROSS,
          status: PositionStatus.NORMAL,
          qty: { not: ZERO },
        },
        data: { status: PositionStatus.LIQUIDATING },
      });
      if (claim.count === 0) continue; // 선점자에게 양보

      // claim 직후 재검증 — 그 사이 회복됐으면 전부 NORMAL 복귀
      const claimed = await this.executor.findCrossLiquidating(userId);
      for (const p of claimed) await this.executor.emitPosition(p);
      if (!(await this.executor.isCrossAccountBreached(userId, claimed))) {
        for (const p of claimed) await this.executor.restoreNormal(userId, p.tickerSymbol);
        continue;
      }

      this.logger.warn(
        `cross liquidation claimed: user=${userId} symbols=${claimed.map((p) => p.tickerSymbol).join(',')}`,
      );
      await this.runCross(userId);
      return; // tick당 cross 계정 1건
    }
  }

  /** 유저의 NORMAL·qty≠0 cross 포지션 전부(전 심볼). */
  private crossAccountPositions(userId: string) {
    return this.prisma.position.findMany({
      where: {
        userId,
        marginMode: MarginMode.CROSS,
        status: PositionStatus.NORMAL,
        qty: { not: ZERO },
      },
    });
  }

  /** cross 계정 집행 — 유저 단위 busy 락으로 다중 심볼 tick의 동시 진입 차단. */
  private async runCross(userId: string): Promise<void> {
    if (this.busyCrossUsers.has(userId)) return;
    this.busyCrossUsers.add(userId);
    try {
      await this.executor.liquidateCross(userId);
    } finally {
      this.busyCrossUsers.delete(userId);
    }
  }

  /** 시퀀스 집행은 executor 위임 — 재진입/spy 진입점 유지. */
  async liquidate(userId: string, symbol: string): Promise<void> {
    return this.executor.liquidate(userId, symbol);
  }
}
