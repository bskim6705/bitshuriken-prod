import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { UserStreamModule } from '../user-stream/user-stream.module';
import { OrderListModule } from '../order-list/order-list.module';
import { SettlementModule } from './settlement.module';
import { MatchEventOrchestrator } from './match-event-orchestrator';

// SettlementModule에 합치지 않음 — OrderListModule이 SettlementModule을 import해 순환 발생.
@Module({
  imports: [PrismaModule, SettlementModule, TickerModule, UserStreamModule, OrderListModule],
  providers: [MatchEventOrchestrator],
  exports: [MatchEventOrchestrator],
})
export class MatchEventOrchestratorModule {}
