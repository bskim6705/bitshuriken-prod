import { Global, Module } from '@nestjs/common';
import { MarketType } from '@prisma/client';
import { LedgerModule } from '@app/core-domain/ledger/ledger.module';
import { LedgerScheduler } from './ledger.scheduler';

/**
 * ADR-069 S0: spot 앱의 인메모리 잔고 원장 배선 (SPOT 지갑 소유 토폴로지).
 * 원장은 앱당 단일 상태ful 싱글턴이어야 하므로 forRoot([SPOT])를 여기서 단 1회 등록하고
 * @Global로 재노출 — order/order-list/settlement 워커/스케줄러가 동일 LedgerService·JournalWriter
 * 인스턴스를 공유한다 (PrismaModule/KafkaModule과 같은 공유 인프라 패턴).
 */
@Global()
@Module({
  imports: [LedgerModule.forRoot([MarketType.SPOT])],
  providers: [LedgerScheduler],
  exports: [LedgerModule],
})
export class SpotLedgerModule {}
