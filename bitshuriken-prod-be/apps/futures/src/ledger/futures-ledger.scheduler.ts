import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { JournalTailer } from '@app/core-domain/ledger/journal-tailer';
import { LedgerAvailability } from '@app/core-domain/ledger/ledger-availability';

// 정책 상수는 코드에 (.env 아님). 테일러 폴링 250ms.
const TAILER_INTERVAL_MS = 250;

/**
 * futures 원장 S0 러너. 부트 시퀀스(baseline→리플레이)는 LedgerModule.forRoot의 LedgerBootstrap가
 * 수행하므로 여기선 하지 않는다. 이 러너는 (1) 저널 테일러 주기 폴링(외부 발원 portal 이체 등 포함),
 * (2) 원장 vs Wallet 프로젝션 드리프트 주기 대사만 담당한다. 강등(availability.enabled=false) 시
 * 테일러는 자체 no-op이고 드리프트는 원장 미형성이라 거짓 드리프트가 나므로 스킵한다(F 플래그만 신뢰).
 * 섀도 모드라 진실은 Wallet 경로 — 어떤 실패도 거래 경로에 영향 주지 않는다.
 */
@Injectable()
export class FuturesLedgerScheduler {
  private readonly logger = new Logger(FuturesLedgerScheduler.name);
  private tailing = false;

  constructor(
    private readonly tailer: JournalTailer,
    private readonly availability: LedgerAvailability,
  ) {}

  @Interval(TAILER_INTERVAL_MS)
  async tailerTick(): Promise<void> {
    if (!this.availability.enabled || this.tailing) return;
    this.tailing = true;
    try {
      await this.tailer.tick();
    } catch (e) {
      this.logger.error('ledger tailer tick failed', e as Error);
    } finally {
      this.tailing = false;
    }
  }

}
