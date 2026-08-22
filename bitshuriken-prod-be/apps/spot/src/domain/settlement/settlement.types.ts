import { MarketType } from '@prisma/client';

export interface WalletLeg {
  userId: string;
  assetSymbol: string;
  marketType: MarketType;
  // 부호 있는 string (Decimal 직렬화). worker가 Decimal로 복원해서 increment.
  lockedDelta: string;
  balanceDelta: string;
}

export interface OrderLeg {
  orderId: string;
  executedQtyDelta: string;
  cumulativeQuoteQtyDelta: string;
}
