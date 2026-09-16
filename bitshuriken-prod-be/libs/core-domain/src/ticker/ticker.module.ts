import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { TickerStatsService } from './ticker-stats.service';

@Module({
  imports: [PrismaModule],
  providers: [TickerStatsService],
  exports: [TickerStatsService],
})
export class TickerModule {}
