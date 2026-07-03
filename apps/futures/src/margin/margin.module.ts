import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { MarginService } from './margin.service';

@Module({
  imports: [PrismaModule],
  providers: [MarginService],
  exports: [MarginService],
})
export class MarginModule {}
