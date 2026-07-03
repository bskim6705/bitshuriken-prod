import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { KafkaModule } from '@app/infra/messaging/kafka.module';
import { AuthModule } from '@app/core-domain/auth/auth.module';
import { TwoFactorModule } from '@app/core-domain/two-factor/two-factor.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminMarketController } from './admin-market.controller';
import { AdminMarketService } from './admin-market.service';

@Module({
  imports: [PrismaModule, KafkaModule, AuthModule, TwoFactorModule],
  controllers: [AdminController, AdminMarketController],
  providers: [AdminService, AdminMarketService],
})
export class AdminModule {}
