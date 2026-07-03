import { Module } from '@nestjs/common';
import { FuturesUserEventsService } from './futures-user-events.service';
import { FuturesListenKeyService } from './futures-listen-key.service';

@Module({
  providers: [FuturesUserEventsService, FuturesListenKeyService],
  exports: [FuturesUserEventsService, FuturesListenKeyService],
})
export class FuturesUserEventsModule {}
