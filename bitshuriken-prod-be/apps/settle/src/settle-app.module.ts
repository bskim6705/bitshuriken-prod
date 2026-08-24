import { Controller, Get, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { KafkaModule } from '@app/infra/messaging/kafka.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { MatchEventOrchestratorModule } from '../../spot/src/domain/settlement/match-event-orchestrator.module';
import { SettlementWorker } from '../../spot/src/domain/settlement/settlement.worker';
import { SettlementModule } from '../../spot/src/domain/settlement/settlement.module';
import { UserStreamModule } from '../../spot/src/domain/user-stream/user-stream.module';
import { FuturesMatchResultModule } from '../../futures/src/consumer/futures-match-result.module';
import { FuturesSettlementModule } from '../../futures/src/settlement/futures-settlement.module';
import { SettleMatchResultController } from './consumer/settle-match-result.controller';
import { SettleLedgerModule } from './settle-ledger.module';

/** 헬스 전용 HTTP 표면 — exchange.sh 검증·모니터링용. */
@Controller()
class SettleHealthController {
  @Get('health')
  health(): { ok: true; role: 'settle' } {
    return { ok: true, role: 'settle' };
  }
}

/**
 * settle 프로세스 조립 (M1) — API 앱들에서 들어낸 기계장치의 새 거주지:
 * out DB-효과 컨슈머(스팟 오케스트레이터·선물 서비스) + 양 정산 워커 + 원장
 * 레플리카/프로젝터/드리프트. WS·트리거·mark price·펀딩·청산은 API 앱 잔류.
 */
@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    KafkaModule,
    SettleLedgerModule,
    TickerModule,
    UserStreamModule,
    SettlementModule,
    MatchEventOrchestratorModule,
    FuturesMatchResultModule,
    FuturesSettlementModule,
  ],
  controllers: [SettleMatchResultController, SettleHealthController],
  providers: [SettlementWorker],
})
export class SettleAppModule {}
