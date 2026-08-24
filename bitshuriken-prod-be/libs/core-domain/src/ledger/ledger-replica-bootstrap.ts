import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { JournalTailer } from './journal-tailer';
import { LedgerAvailability } from './ledger-availability';

/**
 * 레플리카 부트 시퀀스 (M1 정산 프로세스): 저널 전량 리플레이만. BASELINE은 소유 앱의 단독
 * 권한이라 여기서 쓰지 않는다 — 소유 앱이 아직 baseline 전이면 리플레이가 빈 저널을 읽고,
 * 이후 테일러 틱이 소유 앱발 엔트리를 따라간다.
 */
@Injectable()
export class LedgerReplicaBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(LedgerReplicaBootstrap.name);

  constructor(
    private readonly availability: LedgerAvailability,
    private readonly tailer: JournalTailer,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.availability.enabled) return;
    const replay = await this.tailer.replayAll();
    this.logger.log(`ledger replica boot: replay applied=${replay.applied} watermark=${replay.watermark}`);
  }
}
