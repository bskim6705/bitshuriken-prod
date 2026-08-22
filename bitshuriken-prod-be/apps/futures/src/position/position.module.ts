import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { PositionService } from './position.service';

@Module({
  imports: [PrismaModule],
  providers: [PositionService],
  exports: [PositionService],
})
export class PositionModule {}
