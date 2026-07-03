import { Module } from '@nestjs/common';
import { RateLimitModule } from '@app/shared/rate-limit/rate-limit.module';
import { AuthHttpModule } from './http/auth/auth.module';
import { TransfersModule } from './http/transfers/transfers.module';
import { SubaccountModule } from './http/subaccount/subaccount.module';
import { FundingModule } from './http/funding/funding.module';
import { HistoryModule } from './http/history/history.module';
import { NetWorthModule } from './http/net-worth/net-worth.module';
import { UnifiedHistoryModule } from './http/unified-history/unified-history.module';
import { LeaderboardModule } from './http/leaderboard/leaderboard.module';
import { AdminModule } from './http/admin/admin.module';

@Module({
  imports: [
    RateLimitModule.forApp('portal'),
    AuthHttpModule,
    TransfersModule,
    SubaccountModule,
    FundingModule,
    HistoryModule,
    NetWorthModule,
    UnifiedHistoryModule,
    LeaderboardModule,
    AdminModule,
  ],
})
export class PortalAppModule {}
