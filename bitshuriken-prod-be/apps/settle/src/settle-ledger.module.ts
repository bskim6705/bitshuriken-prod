import { Global, Module } from '@nestjs/common';
import { MarketType } from '@prisma/client';
import { LedgerModule } from '@app/core-domain/ledger/ledger.module';
import { SettleLedgerScheduler } from './settle-ledger.scheduler';

/**
 * settle 프로세스의 원장 배선: 양 마켓 읽기 레플리카 (부팅 리플레이 + 테일 ≤250ms 랙,
 * BASELINE은 소유 앱 단독 권한이라 안 씀). 정산 워커의 자기 append는 로컬 즉시 적용
 * (applyJournalRowsLocally)이라 자기 쓰기는 랙 없음. 프로젝터·드리프트는 여기가 단독 구동.
 */
@Global()
@Module({
  imports: [LedgerModule.forReplica([MarketType.SPOT, MarketType.FUTURES])],
  providers: [SettleLedgerScheduler],
  exports: [LedgerModule],
})
export class SettleLedgerModule {}
