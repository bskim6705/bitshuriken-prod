import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { AuthModule } from '@app/core-domain/auth/auth.module';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [TransfersController],
  providers: [TransfersService],
})
export class TransfersModule {}
