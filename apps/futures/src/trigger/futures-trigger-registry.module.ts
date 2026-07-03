import { Module } from '@nestjs/common';
import { FuturesTriggerRegistryService } from './futures-trigger-registry.service';

// TriggerModule과 분리 — Trading 모듈이 TriggerService 없이 registry만 쓰도록 (순환 차단).
@Module({
  providers: [FuturesTriggerRegistryService],
  exports: [FuturesTriggerRegistryService],
})
export class FuturesTriggerRegistryModule {}
