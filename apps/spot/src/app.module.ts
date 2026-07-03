import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller';

// infra
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { KafkaModule } from '@app/infra/messaging/kafka.module';
import { RateLimitModule } from '@app/shared/rate-limit/rate-limit.module';

// domain (cross-product — 인증 발급은 portal 앱, 여기서는 검증만)
import { AuthModule } from '@app/core-domain/auth/auth.module';
import { UserModule } from '@app/core-domain/user/user.module';
import { WalletModule } from '@app/core-domain/wallet/wallet.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { OrderBookModule } from '@app/core-domain/orderbook/orderbook.module';

// domain (spot 소유)
import { OrderModule } from './domain/order/order.module';
import { TradeModule } from './domain/trade/trade.module';
import { SettlementModule } from './domain/settlement/settlement.module';

// http inbound
import { SpotHttpModule } from './http/rest/spot/spot.module';
import { WsModule } from './http/ws/ws.module';

// kafka inbound
import { MatchResultModule } from './consumer/match-result.module';
import { MarketDataModule } from './consumer/market-data.module';
import { TickerControlModule } from './consumer/ticker-control.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    RateLimitModule.forApp('spot'),
    // infra
    PrismaModule,
    KafkaModule,
    // domain (cross-product)
    AuthModule,
    UserModule,
    WalletModule,
    TickerModule,
    OrderBookModule,
    // spot
    OrderModule,
    TradeModule,
    SettlementModule,
    SpotHttpModule,
    WsModule,
    MatchResultModule,
    MarketDataModule,
    TickerControlModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
