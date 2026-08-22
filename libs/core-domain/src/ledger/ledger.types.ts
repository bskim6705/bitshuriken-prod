import { BalanceJournalKind, MarketType } from '@prisma/client';

// Wallet PK(userId, assetSymbol, marketType)를 그대로 미러링한 원장 키.
export interface WalletKeyParts {
  userId: string;
  assetSymbol: string;
  marketType: MarketType;
}

/** 원장 인메모리 잔고 — 항상 ×10^8 정수 bigint. */
export interface ScaledBalance {
  balance: bigint;
  locked: bigint;
}

/**
 * 저널 엔트리의 원장 적용 형태. deltaBalance/deltaLocked는 ×10^8 정수 bigint 증분(부호 있음).
 * JournalTailer/replay가 DB의 Decimal delta를 toScaledBigint로 변환해 채운다.
 */
export interface LedgerEntry {
  seq: number;
  sourceKey: string;
  userId: string;
  assetSymbol: string;
  marketType: MarketType;
  deltaBalance: bigint;
  deltaLocked: bigint;
}

/** JournalWriter INSERT 입력 — 금액은 BE 내부 표현(Decimal). */
export interface JournalInput {
  userId: string;
  assetSymbol: string;
  marketType: MarketType;
  kind: BalanceJournalKind;
  deltaBalance: import('@prisma/client/runtime/library').Decimal;
  deltaLocked: import('@prisma/client/runtime/library').Decimal;
  sourceKey: string;
  meta?: Record<string, unknown>;
}

/** DriftChecker 결과 — 원장 vs Wallet 프로젝션 불일치 1건. */
export interface DriftRow {
  key: string; // `${userId} ${assetSymbol} ${marketType}`
  userId: string;
  assetSymbol: string;
  marketType: MarketType;
  ledgerBalance: string; // 8dp
  ledgerLocked: string;
  walletBalance: string | null; // null = Wallet 행 부재
  walletLocked: string | null;
  balanceDiff: string; // ledger − wallet (8dp)
  lockedDiff: string;
}

/** (userId, assetSymbol, marketType) 합성 키 — settlement.worker의 walletKey와 동일 규칙. */
export function ledgerKey(k: WalletKeyParts): string {
  return `${k.userId} ${k.assetSymbol} ${k.marketType}`;
}

/** ledgerKey 역파싱 — `${userId} ${assetSymbol} ${marketType}`. marketType은 마지막 토큰. */
export function parseLedgerKey(key: string): WalletKeyParts {
  const idx2 = key.lastIndexOf(' ');
  const idx1 = key.lastIndexOf(' ', idx2 - 1);
  return {
    userId: key.slice(0, idx1),
    assetSymbol: key.slice(idx1 + 1, idx2),
    marketType: key.slice(idx2 + 1) as MarketType,
  };
}
