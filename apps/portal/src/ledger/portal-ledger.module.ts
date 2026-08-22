import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '@app/infra/prisma/prisma.module';
import { JournalWriter } from '@app/core-domain/ledger/journal-writer';
import { LedgerAvailability } from '@app/core-domain/ledger/ledger-availability';

/**
 * portal의 저널 append 전용 배선. portal은 원장을 소유하지 않으므로(소유: be-spot/be-futures)
 * LedgerModule.forRoot 대신 LedgerAvailability + JournalWriter만 앱당 싱글턴으로 제공한다 —
 * LedgerService/JournalTailer 미제공. @Global 재노출로 feature 모듈(transfers/subaccount/funding/
 * admin)이 재-import 없이 같은 인스턴스를 주입받고, availability 부트 프로브도 앱당 1회가 된다
 * (spot/futures 앱의 *-ledger.module과 동형 패턴).
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [LedgerAvailability, JournalWriter],
  exports: [LedgerAvailability, JournalWriter],
})
export class PortalLedgerModule {}
