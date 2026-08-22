import { Module } from '@nestjs/common';
import { OrderModule } from '../../../../domain/order/order.module';
import { OrderListModule } from '../../../../domain/order-list/order-list.module';
import { WalletModule } from '@app/core-domain/wallet/wallet.module';
import { TradeModule } from '../../../../domain/trade/trade.module';
import { UserModule } from '@app/core-domain/user/user.module';
import { AuthModule } from '@app/core-domain/auth/auth.module';
import { AccountController } from './account.controller';

@Module({
  imports: [OrderModule, OrderListModule, WalletModule, TradeModule, UserModule, AuthModule],
  controllers: [AccountController],
})
export class AccountModule {}
