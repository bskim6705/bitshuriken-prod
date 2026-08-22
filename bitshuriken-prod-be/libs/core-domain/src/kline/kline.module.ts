import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { TickerModule } from '../ticker/ticker.module';
import { KlineService } from './kline.service';

@Module({
  imports: [PrismaModule, TickerModule],
  providers: [KlineService],
  exports: [KlineService],
})
export class KlineModule {}
