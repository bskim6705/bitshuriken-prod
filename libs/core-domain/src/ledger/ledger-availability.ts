import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';

/**
 * 부트 강등 체크 (정산 DLQ 강등과 동일 패턴). 모듈 init에서 BalanceJournal 테이블 존재를 1회
 * 프로브하고, 부재(balance-journal 마이그레이션 미적용)면 원장/저널링 전체를 비활성으로 강등한다:
 * JournalWriter는 no-op(호출측 tx에 stmt를 발행하지 않아 tx를 깨지 않음), JournalTailer/
 * LedgerBaseliner는 정지. 마이그레이션 적용 후 재기동하면 자동 활성화.
 * 후속 배선(spot/futures/portal)은 이 플래그만 신뢰한다 — 자체 가드 금지.
 * 강등은 섀도 단계 전제의 안전장치 — 기존 Wallet 경로가 진실로 남아 있어 무해하다.
 */
@Injectable()
export class LedgerAvailability implements OnModuleInit {
  private readonly logger = new Logger(LedgerAvailability.name);
  private available = false;
  private probed = false;

  constructor(private readonly prisma: PrismaService) {}

  /** probe 전에는 false — 모듈 init(listen 전)이 probe를 보장하므로 트래픽은 확정값만 본다. */
  get enabled(): boolean {
    return this.available;
  }

  async onModuleInit(): Promise<void> {
    await this.probe();
  }

  /** 1회 프로브. 테이블/컬럼 부재(P2021/P2022)만 강등, 그 외 에러는 그대로 throw (fail loudly). */
  async probe(): Promise<boolean> {
    if (this.probed) return this.available;
    try {
      await this.prisma.balanceJournal.findFirst({ select: { id: true } });
      this.available = true;
    } catch (e) {
      if (isMissingSchema(e)) {
        this.available = false;
        this.logger.error(
          'BalanceJournal table missing — ledger/journaling DISABLED (degrade mode); ' +
            'run the balance-journal prisma migration and restart',
        );
      } else {
        throw e;
      }
    }
    this.probed = true;
    return this.available;
  }
}

function isMissingSchema(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.code === 'P2021' || e.code === 'P2022')
  );
}
