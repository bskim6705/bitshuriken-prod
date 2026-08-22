import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DriftChecker } from '@app/core-domain/ledger/drift-checker';
import { JournalTailer } from '@app/core-domain/ledger/journal-tailer';
import { LedgerAvailability } from '@app/core-domain/ledger/ledger-availability';
import { LedgerProjector } from '@app/core-domain/ledger/ledger-projector';
import { LEDGER_TRUTH } from '@app/core-domain/ledger/ledger-truth';

// ADR-069 구동 상수는 코드에 (feedback-020). 부트 리플레이/베이스라인은 LedgerModule 소관.
const TAIL_INTERVAL_MS = 250;
const PROJECT_INTERVAL_MS = 250;
const DRIFT_INTERVAL_MS = 30_000;

/**
 * spot 원장 주기 구동: 저널 테일러(외부 발원 엔트리 흡수) + Wallet 행 프로젝터(S2 진실 스위치 시) +
 * 드리프트 감시(원장 vs Wallet 프로젝션). 각 잡은 re-entrancy 가드로 겹침 방지.
 */
@Injectable()
export class LedgerScheduler {
  private readonly logger = new Logger(LedgerScheduler.name);
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
  async checkDrift(): Promise<void> {
    // 강등 시 원장은 비어 있고 Wallet은 살아 있어 전 행이 거짓 드리프트로 잡힌다 — 플래그만 신뢰(강등=무대사).
    if (!this.availability.enabled) return;
    if (this.checking) return;
    this.checking = true;
    try {
      // S2: 프로젝션 랙 창의 순간 드리프트는 정상 → 2틱 연속만 error. S0: 즉시(행이 진실).
      if (LEDGER_TRUTH) {
        const { all, persistent } = await this.drift.checkPersistent();
        if (persistent.length > 0) {
          const f = persistent[0];
          this.logger.error(
            `[ledger-drift] market=SPOT persistent=${persistent.length} count=${all.length} ` +
              `first=${f.key} balanceDiff=${f.balanceDiff} lockedDiff=${f.lockedDiff}`,
          );
        } else {
          this.logger.debug(`[ledger-drift] market=SPOT persistent=0 count=${all.length}`);
        }
      } else {
        const drifts = await this.drift.check();
        if (drifts.length > 0) {
          const f = drifts[0];
          this.logger.error(
            `[ledger-drift] market=SPOT count=${drifts.length} first=${f.key} ` +
              `balanceDiff=${f.balanceDiff} lockedDiff=${f.lockedDiff}`,
          );
        } else {
          this.logger.debug('[ledger-drift] market=SPOT count=0');
        }
      }
    } catch (e) {
      this.logger.error('ledger drift check failed', e as Error);
    } finally {
      this.checking = false;
    }
  }
}
