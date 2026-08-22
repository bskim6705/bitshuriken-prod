import { Module } from '@nestjs/common';
import { TradingModule } from './trading/trading.module';
import { AccountModule } from './account/account.module';
import { MarketModule } from './market/market.module';
import { UserDataStreamModule } from './user-data-stream/user-data-stream.module';

/**
 * /spot/* 의 모든 controller를 한 모듈에 묶어두는 barrel.
 * AppModule이 ENV-conditional로 product 모듈을 import할 수 있도록 분리.
 */
@Module({
  imports: [TradingModule, AccountModule, MarketModule, UserDataStreamModule],
})
export class SpotHttpModule {}
