import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { JournalTailer } from '@app/core-domain/ledger/journal-tailer';

// ADR-069 구동 상수는 코드에 (feedback-020). 부트 리플레이/베이스라인은 LedgerModule 소관.
const TAIL_INTERVAL_MS = 250;

/**
 * spot 원장 주기 구동: 저널 테일러(외부 발원 엔트리 흡수)만 — M1부터 프로젝터·드리프트 감시는
 * settle 프로세스가 단독 구동한다 (프로젝션 이중 실행 방지).
 */
@Injectable()
export class LedgerScheduler {
  private readonly logger = new Logger(LedgerScheduler.name);
  private tailing = false;

  constructor(
    private readonly tailer: JournalTailer,
  ) {}

  @Interval(TAIL_INTERVAL_MS)
  async tail(): Promise<void> {
    if (this.tailing) return;
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
