import { Injectable, Logger } from '@nestjs/common';
import { BalanceJournal, MarketType, Prisma } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { LedgerAvailability } from './ledger-availability';
import { JournalInput } from './ledger.types';

/**
 * sourceKey 규칙 (기존 SettlementEvent 스타일과 일관 — dust:{orderId}, frefund:{orderId} 등).
 * 멱등 키이며 BalanceJournal.sourceKey @unique가 이중 INSERT를 차단한다. 정산 leg는 원 sourceKey를
 * 그대로 재사용하고, 신규 저널 대상(place-lock·이체·조정·마진 등)만 여기 접두사를 쓴다.
 */
export const SourceKey = {
  spotPlaceLock: (orderId: string) => `lock:${orderId}`,
  spotOcoLock: (listId: string) => `lock:list:${listId}`,
  futuresPlaceLock: (orderId: string) => `lock:${orderId}`,
  futuresRefund: (orderId: string) => `frefund:${orderId}`,
  transferOut: (fundingTxId: string) => `xferout:${fundingTxId}`,
  transferIn: (fundingTxId: string) => `xferin:${fundingTxId}`,
  deposit: (fundingTxId: string) => `deposit:${fundingTxId}`,
  withdrawal: (fundingTxId: string) => `withdraw:${fundingTxId}`,
  adminAdjust: (fundingTxId: string) => `adjust:${fundingTxId}`,
  marginAdd: (orderId: string) => `marginadd:${orderId}`,
  marginRemove: (orderId: string) => `marginrm:${orderId}`,
  baseline: (userId: string, asset: string, market: MarketType) =>
    `baseline:${userId}:${asset}:${market}`,
} as const;

/**
 * BalanceJournal INSERT 헬퍼. 두 경로:
 *  - writeInTx(tx, ...): 호출자 트랜잭션에 합류 — place 경로가 Order INSERT와 저널을 원자 결합
 *    (이중 쓰기 경계 원천 차단). 중복 sourceKey는 여기서 삼키지 않는다(호출자 tx가 판단).
 *  - write(...): 단독 tx — 워커/콜드 플로우. 중복 sourceKey(P2002)는 멱등 no-op으로 swallow.
 * 강등(LedgerAvailability disabled) 시 전 경로가 no-op(null/[]) — 호출측 tx에 어떤 stmt도
 * 발행하지 않으므로 tx가 깨지지 않는다.
 */
@Injectable()
export class JournalWriter {
  private readonly logger = new Logger(JournalWriter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: LedgerAvailability,
  ) {}

  private data(input: JournalInput): Prisma.BalanceJournalCreateManyInput {
    return {
      userId: input.userId,
      assetSymbol: input.assetSymbol,
      marketType: input.marketType,
      kind: input.kind,
      deltaBalance: input.deltaBalance,
      deltaLocked: input.deltaLocked,
      sourceKey: input.sourceKey,
      meta: (input.meta ?? undefined) as Prisma.InputJsonValue | undefined,
    };
  }

  /** 호출자 tx에 합류하는 INSERT (place/원자 결합). 반환된 row.seq가 전역 순서. 강등 시 null. */
  async writeInTx(
    tx: Prisma.TransactionClient,
    input: JournalInput,
  ): Promise<BalanceJournal | null> {
    if (!this.availability.enabled) return null;
    return tx.balanceJournal.create({ data: this.data(input) });
  }

  /**
   * batch $transaction([...]) 합류용 create-op(PrismaPromise) — 실행하지 않고 반환한다. place 경로가
   * Order INSERT와 저널을 인터랙티브 tx(AsyncLocalStorage 오버헤드) 없이 원자 결합하도록. writeInTx와
   * 동일 data/멱등(sourceKey @unique) 시맨틱. 강등 시 null → 호출측이 배열에서 제외(주문만 커밋).
   */
  createInBatch(input: JournalInput): Prisma.PrismaPromise<BalanceJournal> | null {
    if (!this.availability.enabled) return null;
    return this.prisma.balanceJournal.create({ data: this.data(input) });
  }

  /** 여러 leg를 한 tx에 (trade 정산 등 다-leg). seq는 leg별 증가. 강등 시 []. */
  async writeManyInTx(
    tx: Prisma.TransactionClient,
    inputs: JournalInput[],
  ): Promise<BalanceJournal[]> {
    if (!this.availability.enabled) return [];
    const rows: BalanceJournal[] = [];
    for (const input of inputs) {
      rows.push(await tx.balanceJournal.create({ data: this.data(input) }));
    }
    return rows;
  }

  /**
   * 다-leg 배치를 createMany 1왕복으로 (핫패스 — 행별 create 루프는 배치 500이벤트×4레그에서
   * 트랜잭션 안 2000 왕복이었다). 반환 false = 강등(호출측이 로컬 원장 반영을 생략).
   * 원장 로컬 반영은 seq가 필요 없으므로(applied set은 sourceKey) 반환 rows 없이 입력으로 충분.
   */
  async createManyInTx(tx: Prisma.TransactionClient, inputs: JournalInput[]): Promise<boolean> {
    if (!this.availability.enabled) return false;
    if (inputs.length > 0) {
      await tx.balanceJournal.createMany({ data: inputs.map((i) => this.data(i)) });
    }
    return true;
  }

  /** 단독 INSERT (워커/콜드). 중복 sourceKey면 멱등 skip(null). 강등 시 null. */
  async write(input: JournalInput): Promise<BalanceJournal | null> {
    if (!this.availability.enabled) return null;
    try {
      return await this.prisma.balanceJournal.create({ data: this.data(input) });
    } catch (e) {
      if (this.isUniqueViolation(e)) {
        this.logger.debug(`duplicate journal sourceKey ${input.sourceKey} — skip`);
        return null;
      }
      throw e;
    }
  }

  private isUniqueViolation(e: unknown): boolean {
    return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
  }
}
