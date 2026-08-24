import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { UserModule } from '@app/core-domain/user/user.module';
import { FuturesUserEventsModule } from '../user-events/futures-user-events.module';
import { FuturesMatchResultService } from './futures-match-result.service';

/** futures out DB-효과 컨슈머 서비스 배선 — M1부터 settle 프로세스 전용. */
@Module({
  imports: [PrismaModule, TickerModule, UserModule, FuturesUserEventsModule],
  providers: [FuturesMatchResultService],
  exports: [FuturesMatchResultService],
})
export class FuturesMatchResultModule {}
