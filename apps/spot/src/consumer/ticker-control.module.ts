import { Module } from '@nestjs/common';
import { TickerModule } from '@app/core-domain/ticker/ticker.module';
import { TickerControlController } from './ticker-control.controller';

@Module({
  imports: [TickerModule],
  controllers: [TickerControlController],
})
export class TickerControlModule {}
