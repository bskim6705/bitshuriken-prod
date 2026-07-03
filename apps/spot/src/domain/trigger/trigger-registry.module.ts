import { Module } from '@nestjs/common';
import { TriggerRegistryService } from './trigger-registry.service';

// TriggerModule과 분리 — Order/OrderList 모듈이 TriggerService 없이 registry만 쓰도록 (순환 차단).
@Module({
  providers: [TriggerRegistryService],
  exports: [TriggerRegistryService],
})
export class TriggerRegistryModule {}
