import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DriftChecker } from '@app/core-domain/ledger/drift-checker';
import { JournalTailer } from '@app/core-domain/ledger/journal-tailer';
import { LedgerAvailability } from '@app/core-domain/ledger/ledger-availability';
import { LedgerProjector } from '@app/core-domain/ledger/ledger-projector';
import { LEDGER_TRUTH } from '@app/core-domain/ledger/ledger-truth';
import { LedgerService } from '@app/core-domain/ledger/ledger.service';

// 정책 상수는 코드에 (.env 아님). 테일러/프로젝터 폴링 250ms, 드리프트 대사 30s.
const TAILER_INTERVAL_MS = 250;
const PROJECT_INTERVAL_MS = 250;
const DRIFT_INTERVAL_MS = 30_000;
const MARKET = 'FUTURES';
const DRIFT_SAMPLE = 5;

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
  private projecting = false;

  constructor(
    private readonly tailer: JournalTailer,
    private readonly drift: DriftChecker,
    private readonly projector: LedgerProjector,
    private readonly ledger: LedgerService,
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

  @Interval(PROJECT_INTERVAL_MS)
  async projectTick(): Promise<void> {
    // 진실 스위치 OFF면 projector가 자체 no-op(Wallet 행이 진실이라 덮어쓰기 금지).
    if (this.projecting) return;
    this.projecting = true;
    try {
      await this.projector.project();
    } catch (e) {
      this.logger.error('ledger projector tick failed', e as Error);
    } finally {
      this.projecting = false;
    }
  }

  @Interval(DRIFT_INTERVAL_MS)
  async driftCheck(): Promise<void> {
    if (!this.availability.enabled) return;
    // S2: 프로젝션 랙 창의 순간 드리프트는 정상 → 2틱 연속만 error. S0: 즉시(행이 진실).
    let all;
    let persistent;
    try {
      if (LEDGER_TRUTH) {
        ({ all, persistent } = await this.drift.checkPersistent());
      } else {
        all = await this.drift.check();
        persistent = all;
      }
    } catch (e) {
      this.logger.error('ledger drift check failed', e as Error);
      return;
    }
    const base = `[ledger-drift] market=${MARKET} persistent=${persistent.length} count=${all.length} watermark=${this.tailer.currentWatermark()} keys=${this.ledger.size()}`;
    if (persistent.length === 0) {
      this.logger.debug(base);
      return;
    }
    const sample = persistent
      .slice(0, DRIFT_SAMPLE)
      .map((d) => `${d.key}(Δbal=${d.balanceDiff} Δlock=${d.lockedDiff})`)
      .join(' ');
    this.logger.error(`${base} ${sample}`);
  }
}
