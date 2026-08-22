import { Injectable } from '@nestjs/common';
import { OrderListStatus, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';

export const TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
]);

export type LegTerminalAction = 'ARM_STOP' | 'CANCEL_STOP_LOCALLY' | 'FINALIZE' | 'NONE';

/** OCO 레그 terminal 전이 판정 (순수). 실행은 OcoStateMachine의 guarded claim. */
export function decideLegTerminal(input: {
  cancelRequested: boolean;
  limitStatus: OrderStatus;
  stopStatus: OrderStatus;
  stopArmed: boolean;
  limitExecutedZero: boolean;
}): LegTerminalAction {
  const limitTerminal = TERMINAL_STATUSES.has(input.limitStatus);
  const stopTerminal = TERMINAL_STATUSES.has(input.stopStatus);

  if (limitTerminal && !stopTerminal && input.stopStatus === 'NEW' && !input.stopArmed) {
    // limit이 무체결 취소(CO 결과)이고 유저 취소가 아니면 stop을 엔진으로 (Flow B step 2)
    return input.limitStatus === 'CANCELED' && input.limitExecutedZero && !input.cancelRequested
      ? 'ARM_STOP'
      : 'CANCEL_STOP_LOCALLY';
  }
  if (limitTerminal && stopTerminal) return 'FINALIZE';
  return 'NONE';
}

/** OCO 전이 실행기 — 모든 전이는 guarded updateMany 1회 (멱등, 레이스 중재). */
@Injectable()
export class OcoStateMachine {
  constructor(private prisma: PrismaService) {}

  /** Flow B step 1 claim: stop 트리거됨 표식. 이미 진행 중/취소 요청이면 false. */
  async claimStopPending(listId: string): Promise<boolean> {
    const r = await this.prisma.orderList.updateMany({
      where: { id: listId, stopPendingAt: null, cancelRequested: false, status: 'EXECUTING' },
      data: { stopPendingAt: new Date() },
    });
    return r.count === 1;
  }

  async clearStopPending(listId: string): Promise<void> {
    await this.prisma.orderList.updateMany({
      where: { id: listId },
      data: { stopPendingAt: null },
    });
  }

  /** stop 레그 arming claim (NEW+미트리거 한정) — 취소와의 레이스 중재. */
  async claimArmStop(stopLegId: string): Promise<boolean> {
    const r = await this.prisma.order.updateMany({
      where: { id: stopLegId, status: 'NEW', triggeredAt: null },
      data: { triggeredAt: new Date() },
    });
    return r.count === 1;
  }

  /** stop 레그 로컬 취소 claim (NEW+미트리거 한정). */
  async claimLocalStopCancel(stopLegId: string): Promise<boolean> {
    const r = await this.prisma.order.updateMany({
      where: { id: stopLegId, status: 'NEW', triggeredAt: null },
      data: { status: 'CANCELED' },
    });
    return r.count === 1;
  }

  /** 유저 취소 claim. */
  async claimCancelRequested(listId: string): Promise<boolean> {
    const r = await this.prisma.orderList.updateMany({
      where: { id: listId, status: 'EXECUTING', cancelRequested: false },
      data: { cancelRequested: true },
    });
    return r.count === 1;
  }

  /** 종결 claim — 환불 INSERT와 같은 tx에서 호출. */
  async claimFinalized(
    listId: string,
    finalStatus: OrderListStatus,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const r = await tx.orderList.updateMany({
      where: { id: listId, status: 'EXECUTING' },
      data: { status: finalStatus, stopPendingAt: null },
    });
    return r.count === 1;
  }
}
