import { Module } from '@nestjs/common';
import { MatchEventOrchestratorModule } from '../domain/settlement/match-event-orchestrator.module';
import { MatchResultController } from './match-result.controller';

@Module({
  imports: [MatchEventOrchestratorModule],
  controllers: [MatchResultController],
})
export class MatchResultModule {}
