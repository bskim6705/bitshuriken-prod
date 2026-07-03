import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { FuturesConfigService } from './futures-config.service';

@Module({
  imports: [PrismaModule],
  providers: [FuturesConfigService],
  exports: [FuturesConfigService],
})
export class FuturesConfigModule {}
