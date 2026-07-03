import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { AuthModule } from '@app/core-domain/auth/auth.module';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [HistoryController],
  providers: [HistoryService],
})
export class HistoryModule {}
