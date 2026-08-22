import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { UserService } from './user.service';

@Module({
  imports: [PrismaModule],
  providers: [UserService],
  exports: [UserService],
})
export class UserModule {}
