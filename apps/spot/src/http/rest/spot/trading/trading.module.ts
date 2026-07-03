import { Module } from '@nestjs/common';
import { OrderModule } from '../../../../domain/order/order.module';
import { OrderListModule } from '../../../../domain/order-list/order-list.module';
import { AuthModule } from '@app/core-domain/auth/auth.module';
import { TradingController } from './trading.controller';

@Module({
  imports: [OrderModule, OrderListModule, AuthModule],
  controllers: [TradingController],
})
export class TradingModule {}
