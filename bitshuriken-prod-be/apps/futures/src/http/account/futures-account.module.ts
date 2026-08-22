import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { AuthModule } from '@app/core-domain/auth/auth.module';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { UserModule } from '@app/core-domain/user/user.module';
import { FuturesConfigModule } from '../../config/futures-config.module';
import { MarkPriceModule } from '../../mark-price/mark-price.module';
import { FuturesUserEventsModule } from '../../user-events/futures-user-events.module';
import { FuturesAccountController } from './futures-account.controller';
import { FuturesUserDataStreamController } from './futures-user-data-stream.controller';
import { FuturesAccountService } from './futures-account.service';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    TickerModule,
    UserModule,
    FuturesConfigModule,
    MarkPriceModule,
    FuturesUserEventsModule,
  ],
  controllers: [FuturesAccountController, FuturesUserDataStreamController],
  providers: [FuturesAccountService],
})
export class FuturesAccountModule {}
