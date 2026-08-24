import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DriftChecker } from '@app/core-domain/ledger/drift-checker';
import { JournalTailer } from '@app/core-domain/ledger/journal-tailer';
import { LedgerAvailability } from '@app/core-domain/ledger/ledger-availability';
import { LedgerProjector } from '@app/core-domain/ledger/ledger-projector';
import { LEDGER_TRUTH } from '@app/core-domain/ledger/ledger-truth';

// ADR-069 구동 상수는 코드에 (feedback-020).
const TAIL_INTERVAL_MS = 250;
const PROJECT_INTERVAL_MS = 250;
const DRIFT_INTERVAL_MS = 30_000;

/**
 * settle 원장 주기 구동: 테일러(API발 저널 흡수 — 레플리카 유지) + Wallet 행 프로젝터 +
 * 드리프트 감시. 프로젝터·드리프트는 M1부터 이 프로세스 단독 (API 앱은 테일만).
 */
@Injectable()
export class SettleLedgerScheduler {
  private readonly logger = new Logger(SettleLedgerScheduler.name);
  private tailing = false;
  private projecting = false;
  private checking = false;

  constructor(
    private readonly tailer: JournalTailer,
    private readonly drift: DriftChecker,
    private readonly projector: LedgerProjector,
    private readonly availability: LedgerAvailability,
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

  @Interval(PROJECT_INTERVAL_MS)
  async project(): Promise<void> {
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
  async checkDrift(): Promise<void> {
    if (!this.availability.enabled) return;
    if (this.checking) return;
    this.checking = true;
    try {
      // S2: 프로젝션·레플리카 랙 창의 순간 드리프트는 정상 → 2틱 연속만 error.
      if (LEDGER_TRUTH) {
        const { all, persistent } = await this.drift.checkPersistent();
        if (persistent.length > 0) {
          const f = persistent[0];
          this.logger.error(
            `[ledger-drift] persistent=${persistent.length} count=${all.length} ` +
              `first=${f.key} balanceDiff=${f.balanceDiff} lockedDiff=${f.lockedDiff}`,
          );
        } else {
          this.logger.debug(`[ledger-drift] persistent=0 count=${all.length}`);
        }
      } else {
        const drifts = await this.drift.check();
        if (drifts.length > 0) {
          const f = drifts[0];
          this.logger.error(
            `[ledger-drift] count=${drifts.length} first=${f.key} ` +
              `balanceDiff=${f.balanceDiff} lockedDiff=${f.lockedDiff}`,
          );
        }
      }
    } catch (e) {
      this.logger.error('ledger drift check failed', e as Error);
    } finally {
      this.checking = false;
    }
  }
}
