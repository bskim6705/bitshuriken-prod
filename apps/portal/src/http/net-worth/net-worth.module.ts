import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { AuthModule } from '@app/core-domain/auth/auth.module';
import { NetWorthController } from './net-worth.controller';
import { NetWorthService } from './net-worth.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [NetWorthController],
  providers: [NetWorthService],
})
export class NetWorthModule {}
