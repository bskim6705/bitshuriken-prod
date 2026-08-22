import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { AuthModule } from '@app/core-domain/auth/auth.module';
import { UnifiedHistoryController } from './unified-history.controller';
import { UnifiedHistoryService } from './unified-history.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [UnifiedHistoryController],
  providers: [UnifiedHistoryService],
})
export class UnifiedHistoryModule {}
