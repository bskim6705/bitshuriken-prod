import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { LedgerAvailability } from './ledger-availability';
import { LEDGER_TRUTH } from './ledger-truth';
import { LedgerService } from './ledger.service';
import { parseLedgerKey } from './ledger.types';

/**
 * ADR-069 S2 Wallet 행 프로젝터. 진실 스위치 ON이면 Wallet 행은 읽기 프로젝션 — 원장이 변이한 키를
 * **절대값**으로 주기 upsert한다(워터마크 영속 불필요·멱등). 크래시 후 최초 1회는 전 키를 재프로젝션해
 * 수렴시키고, 이후엔 dirty 키만 반영한다(목표 랙 ≤1s, §6-5).
 *
 * S0(LEDGER_TRUTH=false)에서는 Wallet 행이 진실이므로 절대 덮어쓰지 않는다(전 경로 no-op). 소유 앱만
 * 실행(spot=SPOT, futures=FUTURES) — 원장이 소유 키만 보유하므로 upsert도 소유 마켓 행만 건드린다.
 * portal의 S0 직접 행 갱신(이체/입출금 콜드 플로우)과 일시 교차할 수 있으나, 그 저널을 소유 앱
 * 테일러가 흡수해 원장이 수렴하면 다음 틱에 프로젝션이 따라잡는다.
 */
@Injectable()
export class LedgerProjector {
  private readonly logger = new Logger(LedgerProjector.name);
  private booted = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly availability: LedgerAvailability,
  ) {}

  /** 소유 앱 스케줄러가 @Interval(250ms)로 호출. 강등/비-진실 모드면 no-op. */
  async project(): Promise<{ projected: number }> {
    if (!LEDGER_TRUTH || !this.availability.enabled) return { projected: 0 };

    // 부트 후 최초 1회는 전 키(크래시 수렴), 이후 dirty만.
    const keys = this.booted ? this.ledger.drainDirty() : this.ledger.allKeys();
    this.booted = true;
    if (keys.length === 0) return { projected: 0 };

    // dirty 키들의 절대값 upsert를 틱당 단일 tx로 배치 — 직렬 왕복(~180/s)을 1회 왕복으로 접는다.
    // 절대값·멱등이라 순서·중복 무관. 소유 마켓 행만 (원장이 소유 키만 보유).
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    for (const key of keys) {
      const parts = parseLedgerKey(key);
      if (!this.ledger.owns(parts.marketType)) continue;
      const { balance, locked } = this.ledger.getDecimal(parts);
      ops.push(
        this.prisma.wallet.upsert({
          where: {
            userId_assetSymbol_marketType: {
              userId: parts.userId,
              assetSymbol: parts.assetSymbol,
              marketType: parts.marketType,
            },
          },
          create: {
            userId: parts.userId,
            assetSymbol: parts.assetSymbol,
            marketType: parts.marketType,
            balance,
            locked,
          },
          update: { balance, locked },
        }),
      );
    }
    if (ops.length === 0) return { projected: 0 };
    await this.prisma.$transaction(ops);
    return { projected: ops.length };
  }
}
