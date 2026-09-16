import { Injectable } from '@nestjs/common';
import { MarketType, Prisma } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { LedgerService } from './ledger.service';
import { DriftRow, ScaledBalance, WalletKeyParts, ledgerKey, parseLedgerKey } from './ledger.types';
import { formatScaled, toScaledBigint } from './scaled';

/**
 * ADR-069 섀도 게이트 재료 (S0 상시 대사 / F1~F4 통합). 원장(진실 후보) vs Wallet 행(프로젝션)을
 * balance·locked **정확 일치**(scaled bigint 상등)로 대사한다. Wallet은 SELECT만 — 쓰기 없음.
 * 소유 마켓으로 스코프. 불일치(원장에만/프로젝션에만 존재 포함) 목록을 반환한다(빈 배열 = 무드리프트).
 */
@Injectable()
export class DriftChecker {
  // 직전 틱 드리프트: 키 → diff 시그니처(balanceDiff|lockedDiff) — persistent 판정 재료.
  private prevDrifts = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * S2 시맨틱: 프로젝션은 설계상 ≤1s 뒤처져 순간 드리프트가 정상. 핫 키(고빈도 봇 지갑)는 랙 창
   * 때문에 매 틱 다른 값의 순간 diff가 항상 잡혀 키-단독 2틱 연속 판정은 churn 중 오탐이었다
   * (라이브 실측). 따라서 persistent는 **같은 키 AND 같은 diff(balance·locked 모두 동일)가
   * 연속 2틱**일 때만 확정한다 — 진짜 누수(빠진 델타)는 quiesce 여부와 무관하게 diff가 상수로
   * 고정되고, 랙 diff는 매 틱 값이 변한다. all은 현 틱 전체(관측용).
   * quiesce(드레인 후) 상태에선 프로젝터가 따라잡아 all=persistent=0이 기대치.
   */
  async checkPersistent(): Promise<{ all: DriftRow[]; persistent: DriftRow[] }> {
    const all = await this.check();
    const persistent = all.filter((d) => this.prevDrifts.get(d.key) === diffSig(d));
    this.prevDrifts = new Map(all.map((d) => [d.key, diffSig(d)]));
    return { all, persistent };
  }

  async check(): Promise<DriftRow[]> {
    const owned = this.ledger.ownedMarketList();
    const where: Prisma.WalletWhereInput =
      owned.length > 0 ? { marketType: { in: owned as MarketType[] } } : {};
    const wallets = await this.prisma.wallet.findMany({ where });

    const ledgerSnap = this.ledger.snapshot();
    const seen = new Set<string>();
    const drifts: DriftRow[] = [];

    // 프로젝션 기준 대사 (원장에 없거나 값이 다른 행).
    for (const w of wallets) {
      const parts: WalletKeyParts = {
        userId: w.userId,
        assetSymbol: w.assetSymbol,
        marketType: w.marketType,
      };
      const key = ledgerKey(parts);
      seen.add(key);
      const led = this.ledger.getScaled(parts);
      const wb = toScaledBigint(w.balance);
      const wl = toScaledBigint(w.locked);
      if (led.balance !== wb || led.locked !== wl) {
        drifts.push(this.row(parts, led, { balance: wb, locked: wl }));
      }
    }

    // 원장에만 있고 Wallet 행이 없는 키.
    for (const [key, led] of ledgerSnap) {
      if (seen.has(key)) continue;
      if (led.balance === 0n && led.locked === 0n) continue; // 빈 슬롯은 드리프트 아님
      const parts = parseLedgerKey(key);
      if (owned.length > 0 && !owned.includes(parts.marketType)) continue;
      drifts.push(this.row(parts, led, null));
    }

    return drifts;
  }

  private row(
    parts: WalletKeyParts,
    led: ScaledBalance,
    wallet: ScaledBalance | null,
  ): DriftRow {
    const wb = wallet?.balance ?? 0n;
    const wl = wallet?.locked ?? 0n;
    return {
      key: ledgerKey(parts),
      userId: parts.userId,
      assetSymbol: parts.assetSymbol,
      marketType: parts.marketType,
      ledgerBalance: formatScaled(led.balance),
      ledgerLocked: formatScaled(led.locked),
      walletBalance: wallet ? formatScaled(wallet.balance) : null,
      walletLocked: wallet ? formatScaled(wallet.locked) : null,
      balanceDiff: formatScaled(led.balance - wb),
      lockedDiff: formatScaled(led.locked - wl),
    };
  }
}

/** persistent 비교용 diff 시그니처 — balance·locked 모두 동일해야 같은 드리프트로 본다. */
function diffSig(d: DriftRow): string {
  return `${d.balanceDiff}|${d.lockedDiff}`;
}

