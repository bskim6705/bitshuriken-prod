import { Module } from '@nestjs/common';
import { AuthModule } from '@app/core-domain/auth/auth.module';
import { UserStreamModule } from '../../../../domain/user-stream/user-stream.module';
import { UserDataStreamController } from './user-data-stream.controller';

@Module({
  imports: [AuthModule, UserStreamModule],
  controllers: [UserDataStreamController],
})
export class UserDataStreamModule {}
