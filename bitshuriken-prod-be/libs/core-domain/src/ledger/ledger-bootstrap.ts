import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { JournalTailer } from './journal-tailer';
import { LedgerAvailability } from './ledger-availability';
import { LedgerBaseliner } from './ledger-baseliner';

/**
 * 소유 앱 부트 시퀀스: baseline → 저널 전량 리플레이. onApplicationBootstrap은 전 모듈 init
 * (availability 프로브 포함) 후·HTTP listen 전에 실행되므로, 트래픽이 열리기 전에 원장이 선다.
 * 강등 시 no-op (에러 로그는 프로브가 이미 남김).
 * LedgerModule.forRoot(소유 앱 전용)에서만 등록된다 — base 모듈(portal append-only)은 미등록.
 */
@Injectable()
export class LedgerBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger(LedgerBootstrap.name);

  constructor(
    private readonly availability: LedgerAvailability,
    private readonly baseliner: LedgerBaseliner,
    private readonly tailer: JournalTailer,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.availability.enabled) return;
    const results = await this.baseliner.baseline();
    const replay = await this.tailer.replayAll();
    this.logger.log(
      `ledger boot: baseline=[${results
        .map((r) => `${r.market}:${r.status}(${r.created})`)
        .join(', ')}] replay applied=${replay.applied} watermark=${replay.watermark}`,
    );
  }
}
