import { Decimal } from '@prisma/client/runtime/library';
import { floor8 } from '@app/shared/decimal';
import { fundingPayment } from '../math/position-math';
import { FundingLeg } from '../settlement/futures-settlement.types';

// 이자율 0.01%/8h, premium 보정 클램프 ±0.05% — 코드 상수 (DB 필드 아님)
const INTEREST_RATE = new Decimal('0.0001');
const PREMIUM_CLAMP = new Decimal('0.0005');
const ZERO = new Decimal(0);

function clamp(v: Decimal, bound: Decimal): Decimal {
  return Decimal.min(Decimal.max(v, bound.neg()), bound);
}

/** F = avgP + clamp(0.01% − avgP, ±0.05%) 후 ±cap. 샘플 0개(부분 윈도우)면 clamp(0.01%, ±cap). */
export function computeFundingRate(samples: readonly Decimal[], fundingCap: Decimal): Decimal {
  if (samples.length === 0) return floor8(clamp(INTEREST_RATE, fundingCap));
  const avgP = samples.reduce((s, p) => s.add(p), ZERO).div(samples.length);
  const rate = avgP.add(clamp(INTEREST_RATE.sub(avgP), PREMIUM_CLAMP));
  return floor8(clamp(rate, fundingCap));
}

export interface FundingSnapshot {
  userId: string;
  qty: Decimal; // signed
}

export interface FundingBatch {
  legs: FundingLeg[];
  /** floor 라운딩 잔여의 기금 귀속 leg — 포함하면 배치 지급 총합이 정확히 0. 잔여 0이면 null. */
  dustLeg: FundingLeg | null;
}

/** 스냅샷 → 유저별 FUNDING leg + zero-sum dust leg. worker의 fundingPayment 산식으로 잔여를 계산한다. */
export function buildFundingBatch(
  symbol: string,
  rate: Decimal,
  mark: Decimal,
  positions: readonly FundingSnapshot[],
  fundUserId: string,
): FundingBatch {
  const legs: FundingLeg[] = [];
  let total = ZERO;
  for (const p of positions) {
    total = total.add(fundingPayment(rate, mark, p.qty));
    legs.push({
      userId: p.userId,
      symbol,
      rate: rate.toFixed(),
      mark: mark.toFixed(),
      qty: p.qty.toFixed(),
    });
  }

  const dust = total.neg();
  if (dust.isZero()) return { legs, dustLeg: null };
  // fundingPayment(-1, 1, dust) == dust — FundingLeg 형식으로 금액을 그대로 전달하는 단위 인코딩
  return {
    legs,
    dustLeg: { userId: fundUserId, symbol, rate: '-1', mark: '1', qty: dust.toFixed() },
  };
}
