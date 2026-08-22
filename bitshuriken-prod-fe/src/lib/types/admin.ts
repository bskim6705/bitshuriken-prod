import type { UserRole } from "@/lib/api/auth";

export type Market = "SPOT" | "FUTURES";

export type TickerStatus = "PENDING" | "TRADING" | "HALTED" | "DELISTED";

export interface AdminTicker {
  symbol: string;
  marketType: Market;
  baseAsset: string;
  quoteAsset: string;
  status: TickerStatus;
  pricePrecision: number;
  qtyPrecision: number;
  minNotional: string;
  partition: number;
}

export interface AdminUserListItem {
  id: string;
  email: string;
  displayName: string | null;
  role: UserRole;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  restricted: boolean;
  feeMakerBps: number;
  feeTakerBps: number;
  orderCount: number;
  apiKeyCount: number;
  positionCount: number;
  createdAt: number;
}

export interface AdminUserList {
  total: number;
  limit: number;
  offset: number;
  users: AdminUserListItem[];
}

export interface AdminWallet {
  assetSymbol: string;
  marketType: Market;
  balance: string;
  locked: string;
}

export interface AdminPosition {
  tickerSymbol: string;
  qty: string;
  entryPrice: string;
  isolatedMargin: string;
  leverage: number;
  marginMode: "ISOLATED" | "CROSS";
  status: "NORMAL" | "LIQUIDATING";
}

export interface AdminOpenOrder {
  id: string;
  tickerSymbol: string;
  tickerMarket: Market;
  type: string;
  side: "BUY" | "SELL";
  price: string | null;
  origQty: string | null;
  executedQty: string;
  status: string;
  createdAt: number;
}

export interface AdminTx {
  id: string;
  type: string;
  assetSymbol: string;
  qty: string;
  fromMarket: Market | null;
  toMarket: Market | null;
  status: string;
  reason: string | null;
  time: number;
}

export interface AdminApiKey {
  id: string;
  apiKey: string;
  label: string | null;
  canTrade: boolean;
  canRead: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface AdminUserDetail {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    role: UserRole;
    emailVerified: boolean;
    twoFactorEnabled: boolean;
    loginEnabled: boolean;
    tradingEnabled: boolean;
    withdrawalEnabled: boolean;
    feeMakerBps: number;
    feeTakerBps: number;
    createdAt: number;
  };
  wallets: AdminWallet[];
  positions: AdminPosition[];
  openOrders: AdminOpenOrder[];
  recentTransactions: AdminTx[];
  apiKeys: AdminApiKey[];
}

export interface AssetAmount {
  asset: string;
  total: string;
}

export interface AdminOverview {
  users: { total: number; admins: number; restricted: number; new24h: number; new7d: number };
  markets: { total: number; byStatus: Record<string, number> };
  activity: { openOrders: number; openPositions: number; totalTrades: number };
  financials: {
    balancesByAsset: AssetAmount[];
    feeRevenueByAsset: AssetAmount[];
    insuranceFundUsdt: string;
  };
  recentAdjustments: {
    id: string;
    userId: string;
    assetSymbol: string;
    qty: string;
    direction: "credit" | "debit";
    reason: string | null;
    time: number;
  }[];
}
