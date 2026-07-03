import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { OrderBookModule } from '@app/core-domain/orderbook/orderbook.module';
import { FuturesConfigModule } from '../config/futures-config.module';
import { MarkPriceService } from './mark-price.service';

@Module({
  imports: [PrismaModule, OrderBookModule, FuturesConfigModule],
  providers: [MarkPriceService],
  exports: [MarkPriceService],
})
export class MarkPriceModule {}
