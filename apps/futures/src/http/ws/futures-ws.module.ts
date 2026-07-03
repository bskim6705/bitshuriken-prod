import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { OrderBookModule } from '@app/core-domain/orderbook/orderbook.module';
import { KlineModule } from '@app/core-domain/kline/kline.module';
import { SESSION_TTL_SECONDS } from '@app/core-domain/auth/session.config';
import { MarkPriceModule } from '../../mark-price/mark-price.module';
import { FuturesUserEventsModule } from '../../user-events/futures-user-events.module';
import { WsFuturesMarketGateway } from './futures-market.gateway';
import { WsFuturesUserGateway } from './futures-user.gateway';

const secret = process.env.JWT_SECRET;
if (!secret) throw new Error('JWT_SECRET is required');

@Module({
  imports: [
    PrismaModule,
    TickerModule,
    OrderBookModule,
    KlineModule,
    MarkPriceModule,
    FuturesUserEventsModule,
    JwtModule.register({
      secret,
      signOptions: { expiresIn: SESSION_TTL_SECONDS },
    }),
  ],
  providers: [WsFuturesMarketGateway, WsFuturesUserGateway],
  exports: [WsFuturesMarketGateway],
})
export class FuturesWsModule {}
