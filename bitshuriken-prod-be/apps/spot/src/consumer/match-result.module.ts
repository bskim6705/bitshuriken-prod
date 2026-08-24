import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { UserStreamModule } from '../domain/user-stream/user-stream.module';
import { MatchResultLiveController } from './match-result-live.controller';

// M1: API 프로세스는 경량 컨슈머(인메모리 효과)만 — DB 효과는 settle 프로세스의
// SettleMatchResultController(그룹 bitshuriken-settle)가 같은 토픽을 독립 소비한다.
@Module({
  imports: [PrismaModule, TickerModule, UserStreamModule],
  controllers: [MatchResultLiveController],
})
export class MatchResultModule {}
