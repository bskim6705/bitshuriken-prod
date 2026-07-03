import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { TickerService } from './ticker.service';
import { TickerStatsService } from './ticker-stats.service';

@Module({
  imports: [PrismaModule],
  providers: [TickerService, TickerStatsService],
  exports: [TickerService, TickerStatsService],
})
export class TickerModule {}
