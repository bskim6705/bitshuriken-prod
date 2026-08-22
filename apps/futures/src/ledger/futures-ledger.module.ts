import { Global, Module } from '@nestjs/common';
import { MarketType } from '@prisma/client';
import { LedgerModule } from '@app/core-domain/ledger/ledger.module';
import { FuturesLedgerScheduler } from './futures-ledger.scheduler';

// forRoot는 호출마다 새 DynamicModule을 낳아 인스턴스가 갈라진다 — 원장은 앱당 단일 진실이라
// 여기서 딱 한 번 호출하고 그 결과를 import·export한다. @Global로 전 feature 모듈이 재-import 없이
// LedgerService/JournalWriter 단일 인스턴스를 주입받는다 (PrismaModule과 동형).
const LEDGER = LedgerModule.forRoot([MarketType.FUTURES]);

@Global()
@Module({
  imports: [LEDGER],
  providers: [FuturesLedgerScheduler],
  exports: [LEDGER],
})
export class FuturesLedgerModule {}
