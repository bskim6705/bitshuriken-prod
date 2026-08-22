import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { TradeService } from './trade.service';

@Module({
  imports: [PrismaModule, TickerModule],
  providers: [TradeService],
  exports: [TradeService],
})
export class TradeModule {}
