import { DynamicModule, Module } from '@nestjs/common';
import { MarketType } from '@prisma/client';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { DriftChecker } from './drift-checker';
import { JournalTailer } from './journal-tailer';
import { JournalWriter } from './journal-writer';
import { LedgerAvailability } from './ledger-availability';
import { LedgerBaseliner } from './ledger-baseliner';
import { LedgerBootstrap } from './ledger-bootstrap';
import { LedgerReplicaBootstrap } from './ledger-replica-bootstrap';
import { LedgerProjector } from './ledger-projector';
import { LEDGER_OWNED_MARKETS, LedgerService } from './ledger.service';

/**
 * 원장 기반 모듈 (배선 없는 코어). **어느 앱에도 import되지 않는다** — 후속 포드 S/U/P가
 * spot/futures/portal에 배선한다.
 *   be-spot:    LedgerModule.forRoot([MarketType.SPOT])   — 부트 시퀀스(baseline→리플레이) 자동
 *   be-futures: LedgerModule.forRoot([MarketType.FUTURES])
 *   portal:     LedgerModule (base) — JournalWriter만 사용(append 전용), 부트스트랩 없음
 * 모듈 init에서 LedgerAvailability가 테이블 존재를 1회 프로브 — 마이그레이션 전이면 전체 강등
 * (writer no-op, tailer/baseliner 정지). 배선 측은 이 플래그만 신뢰한다.
 */
@Module({
  imports: [PrismaModule],
  providers: [
    LedgerService,
    LedgerAvailability,
    JournalWriter,
    LedgerBaseliner,
    LedgerProjector,
    DriftChecker,
    {
      provide: JournalTailer,
      useFactory: (prisma: PrismaService, ledger: LedgerService, avail: LedgerAvailability) =>
        new JournalTailer(prisma, ledger, avail),
      inject: [PrismaService, LedgerService, LedgerAvailability],
    },
  ],
  exports: [
    LedgerService,
    LedgerAvailability,
    JournalWriter,
    JournalTailer,
    LedgerBaseliner,
    LedgerProjector,
    DriftChecker,
  ],
})
export class LedgerModule {
  static forRoot(ownedMarkets: MarketType[]): DynamicModule {
    return {
      module: LedgerModule,
      providers: [
        { provide: LEDGER_OWNED_MARKETS, useValue: ownedMarkets },
        LedgerBootstrap,
      ],
    };
  }

  /**
   * 읽기 레플리카 배선 (M1 정산 프로세스): 부팅 시 저널 전량 리플레이만 하고 BASELINE은 쓰지
   * 않는다 — baseline 기록은 소유 앱(spot/futures API)의 단독 권한이고, 레플리카가 쓰면 소유
   * 앱과 이중 기록된다. 이후는 테일러 틱이 소유 앱발 저널을 ≤250ms 랙으로 따라간다.
   */
  static forReplica(markets: MarketType[]): DynamicModule {
    return {
      module: LedgerModule,
      providers: [
        { provide: LEDGER_OWNED_MARKETS, useValue: markets },
        LedgerReplicaBootstrap,
      ],
    };
  }
}
