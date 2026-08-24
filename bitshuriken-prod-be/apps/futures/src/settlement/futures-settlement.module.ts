import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { FuturesConfigModule } from '../config/futures-config.module';
import { FuturesUserEventsModule } from '../user-events/futures-user-events.module';
import { InsuranceFundModule } from './insurance-fund.module';
import { FuturesSettlementWorker } from './futures-settlement.worker';
import { MARK_READER, NULL_MARK_READER } from './mark-reader';

/**
 * 정산 워커 배선 — M1부터 settle 프로세스 전용. mark는 legs 동봉이 정산 수학의 소스라
 * MarkPriceModule을 끌지 않고 null-리더를 바인딩한다 (WS 스냅샷 보강만 비활성).
 */
@Module({
  imports: [PrismaModule, FuturesConfigModule, FuturesUserEventsModule, InsuranceFundModule],
  providers: [FuturesSettlementWorker, { provide: MARK_READER, useValue: NULL_MARK_READER }],
})
export class FuturesSettlementModule {}
