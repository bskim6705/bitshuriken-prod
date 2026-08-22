-- CreateEnum
CREATE TYPE "MarketType" AS ENUM ('SPOT', 'FUTURES');

-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('CRYPTO', 'STABLECOIN');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "AuthTokenType" AS ENUM ('EMAIL_VERIFY', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "FundingTxType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'ADJUSTMENT', 'SUBACCOUNT_TRANSFER');

-- CreateEnum
CREATE TYPE "TickerStatus" AS ENUM ('PENDING', 'TRADING', 'HALTED', 'DELISTED');

-- CreateEnum
CREATE TYPE "OrderSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "OrderType" AS ENUM ('MARKET', 'LIMIT', 'POST_ONLY', 'STOP_LOSS', 'STOP_LOSS_LIMIT', 'TAKE_PROFIT', 'TAKE_PROFIT_LIMIT');

-- CreateEnum
CREATE TYPE "ContingencyType" AS ENUM ('OCO');

-- CreateEnum
CREATE TYPE "OrderListStatus" AS ENUM ('EXECUTING', 'ALL_DONE', 'REJECTED');

-- CreateEnum
CREATE TYPE "TimeInForce" AS ENUM ('GTC', 'IOC', 'FOK');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('NEW', 'OPEN', 'PARTIAL', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SettlementKind" AS ENUM ('TRADE', 'DUST_REFUND', 'FUTURES_TRADE', 'FUTURES_REFUND', 'FUNDING', 'LIQUIDATION_TAKEOVER');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'APPLIED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('NORMAL', 'LIQUIDATING');

-- CreateEnum
CREATE TYPE "MarginMode" AS ENUM ('ISOLATED', 'CROSS');

-- CreateEnum
CREATE TYPE "FuturesIncomeType" AS ENUM ('REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE', 'LIQUIDATION_FEE', 'TRANSFER', 'INSURANCE_CLEAR');

-- CreateTable
CREATE TABLE "Asset" (
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "precision" INTEGER NOT NULL,
    "type" "AssetType" NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("symbol")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "hashedPassword" TEXT NOT NULL,
    "displayName" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorSecret" TEXT,
    "feeMakerBps" INTEGER NOT NULL DEFAULT 10,
    "feeTakerBps" INTEGER NOT NULL DEFAULT 10,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "loginEnabled" BOOLEAN NOT NULL DEFAULT true,
    "tradingEnabled" BOOLEAN NOT NULL DEFAULT true,
    "withdrawalEnabled" BOOLEAN NOT NULL DEFAULT true,
    "parentUserId" TEXT,
    "antiPhishingCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "userAgent" TEXT,
    "success" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "AuthTokenType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BalanceSnapshot" (
    "userId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "totalUsdt" DECIMAL(32,8) NOT NULL,
    "spotUsdt" DECIMAL(32,8) NOT NULL,
    "futuresUsdt" DECIMAL(32,8) NOT NULL,
    "breakdown" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BalanceSnapshot_pkey" PRIMARY KEY ("userId","day")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "secretEncrypted" TEXT NOT NULL,
    "label" TEXT,
    "canTrade" BOOLEAN NOT NULL DEFAULT false,
    "canRead" BOOLEAN NOT NULL DEFAULT true,
    "ipWhitelist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundingTx" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "FundingTxType" NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "qty" DECIMAL(32,8) NOT NULL,
    "fromMarket" "MarketType",
    "toMarket" "MarketType",
    "counterpartyUserId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "adminId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FundingTx_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticker" (
    "symbol" TEXT NOT NULL,
    "marketType" "MarketType" NOT NULL,
    "baseAssetSymbol" TEXT NOT NULL,
    "quoteAssetSymbol" TEXT NOT NULL,
    "pricePrecision" INTEGER NOT NULL,
    "qtyPrecision" INTEGER NOT NULL,
    "minNotional" DECIMAL(32,8) NOT NULL DEFAULT 0,
    "partition" INTEGER NOT NULL,
    "status" "TickerStatus" NOT NULL DEFAULT 'TRADING',

    CONSTRAINT "Ticker_pkey" PRIMARY KEY ("symbol","marketType")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "userId" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "marketType" "MarketType" NOT NULL,
    "balance" DECIMAL(32,8) NOT NULL,
    "locked" DECIMAL(32,8) NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("userId","assetSymbol","marketType")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "clientOrderId" TEXT,
    "userId" TEXT NOT NULL,
    "tickerSymbol" TEXT NOT NULL,
    "tickerMarket" "MarketType" NOT NULL,
    "type" "OrderType" NOT NULL,
    "side" "OrderSide" NOT NULL,
    "timeInForce" "TimeInForce" NOT NULL,
    "price" DECIMAL(32,8),
    "stopPrice" DECIMAL(32,8),
    "origQty" DECIMAL(32,8),
    "origQuoteQty" DECIMAL(32,8),
    "executedQty" DECIMAL(32,8) NOT NULL DEFAULT 0,
    "cumulativeQuoteQty" DECIMAL(32,8) NOT NULL DEFAULT 0,
    "status" "OrderStatus" NOT NULL DEFAULT 'NEW',
    "triggeredAt" TIMESTAMP(3),
    "reduceOnly" BOOLEAN NOT NULL DEFAULT false,
    "liquidation" BOOLEAN NOT NULL DEFAULT false,
    "lockedCost" DECIMAL(32,8),
    "orderListId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderList" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tickerSymbol" TEXT NOT NULL,
    "tickerMarket" "MarketType" NOT NULL,
    "side" "OrderSide" NOT NULL,
    "contingencyType" "ContingencyType" NOT NULL,
    "status" "OrderListStatus" NOT NULL DEFAULT 'EXECUTING',
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "stopPendingAt" TIMESTAMP(3),
    "lockAssetSymbol" TEXT NOT NULL,
    "lockAmount" DECIMAL(32,8) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "tickerSymbol" TEXT NOT NULL,
    "tickerMarket" "MarketType" NOT NULL,
    "makerOrderId" TEXT NOT NULL,
    "takerOrderId" TEXT NOT NULL,
    "makerUserId" TEXT NOT NULL,
    "takerUserId" TEXT NOT NULL,
    "takerSide" "OrderSide" NOT NULL,
    "price" DECIMAL(32,8) NOT NULL,
    "qty" DECIMAL(32,8) NOT NULL,
    "makerCommission" DECIMAL(32,8) NOT NULL DEFAULT 0,
    "takerCommission" DECIMAL(32,8) NOT NULL DEFAULT 0,
    "makerCommissionAsset" TEXT,
    "takerCommissionAsset" TEXT,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SettlementEvent" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "kind" "SettlementKind" NOT NULL,
    "legs" JSONB NOT NULL,
    "orderLegs" JSONB NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "SettlementEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "userId" TEXT NOT NULL,
    "tickerSymbol" TEXT NOT NULL,
    "tickerMarket" "MarketType" NOT NULL,
    "qty" DECIMAL(32,8) NOT NULL DEFAULT 0,
    "entryPrice" DECIMAL(32,8) NOT NULL DEFAULT 0,
    "isolatedMargin" DECIMAL(32,8) NOT NULL DEFAULT 0,
    "leverage" INTEGER NOT NULL DEFAULT 10,
    "marginMode" "MarginMode" NOT NULL DEFAULT 'ISOLATED',
    "status" "PositionStatus" NOT NULL DEFAULT 'NORMAL',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("userId","tickerSymbol")
);

-- CreateTable
CREATE TABLE "FuturesConfig" (
    "tickerSymbol" TEXT NOT NULL,
    "maxLeverage" INTEGER NOT NULL,
    "mmr" DECIMAL(10,8) NOT NULL,
    "liquidationFeeRate" DECIMAL(10,8) NOT NULL,
    "maxNotional" DECIMAL(32,8) NOT NULL,
    "fundingCap" DECIMAL(10,8) NOT NULL,
    "priceBandPct" DECIMAL(10,8) NOT NULL,
    "marketCostBufferPct" DECIMAL(10,8) NOT NULL,
    "markClampPct" DECIMAL(10,8) NOT NULL,

    CONSTRAINT "FuturesConfig_pkey" PRIMARY KEY ("tickerSymbol")
);

-- CreateTable
CREATE TABLE "FundingRate" (
    "id" TEXT NOT NULL,
    "tickerSymbol" TEXT NOT NULL,
    "fundingTime" TIMESTAMP(3) NOT NULL,
    "rate" DECIMAL(10,8) NOT NULL,
    "markPrice" DECIMAL(32,8) NOT NULL,

    CONSTRAINT "FundingRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FuturesIncome" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tickerSymbol" TEXT,
    "incomeType" "FuturesIncomeType" NOT NULL,
    "income" DECIMAL(32,8) NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FuturesIncome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_parentUserId_idx" ON "User"("parentUserId");

-- CreateIndex
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "LoginHistory_userId_createdAt_idx" ON "LoginHistory"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LoginHistory_userId_ip_idx" ON "LoginHistory"("userId", "ip");

-- CreateIndex
CREATE UNIQUE INDEX "AuthToken_tokenHash_key" ON "AuthToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthToken_userId_type_idx" ON "AuthToken"("userId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_apiKey_key" ON "ApiKey"("apiKey");

-- CreateIndex
CREATE INDEX "ApiKey_userId_idx" ON "ApiKey"("userId");

-- CreateIndex
CREATE INDEX "FundingTx_userId_createdAt_idx" ON "FundingTx"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_userId_status_idx" ON "Order"("userId", "status");

-- CreateIndex
CREATE INDEX "Order_userId_tickerSymbol_tickerMarket_createdAt_idx" ON "Order"("userId", "tickerSymbol", "tickerMarket", "createdAt");

-- CreateIndex
CREATE INDEX "Order_userId_tickerSymbol_tickerMarket_status_idx" ON "Order"("userId", "tickerSymbol", "tickerMarket", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Order_userId_tickerMarket_clientOrderId_key" ON "Order"("userId", "tickerMarket", "clientOrderId");

-- CreateIndex
CREATE INDEX "OrderList_userId_createdAt_idx" ON "OrderList"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_seq_key" ON "Trade"("seq");

-- CreateIndex
CREATE INDEX "Trade_tickerSymbol_tickerMarket_executedAt_idx" ON "Trade"("tickerSymbol", "tickerMarket", "executedAt");

-- CreateIndex
CREATE INDEX "Trade_makerUserId_createdAt_idx" ON "Trade"("makerUserId", "createdAt");

-- CreateIndex
CREATE INDEX "Trade_takerUserId_createdAt_idx" ON "Trade"("takerUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementEvent_seq_key" ON "SettlementEvent"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "SettlementEvent_sourceKey_key" ON "SettlementEvent"("sourceKey");

-- CreateIndex
CREATE INDEX "SettlementEvent_status_createdAt_idx" ON "SettlementEvent"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FundingRate_tickerSymbol_fundingTime_key" ON "FundingRate"("tickerSymbol", "fundingTime");

-- CreateIndex
CREATE UNIQUE INDEX "FuturesIncome_sourceKey_key" ON "FuturesIncome"("sourceKey");

-- CreateIndex
CREATE INDEX "FuturesIncome_userId_createdAt_idx" ON "FuturesIncome"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_parentUserId_fkey" FOREIGN KEY ("parentUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginHistory" ADD CONSTRAINT "LoginHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthToken" ADD CONSTRAINT "AuthToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BalanceSnapshot" ADD CONSTRAINT "BalanceSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FundingTx" ADD CONSTRAINT "FundingTx_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticker" ADD CONSTRAINT "Ticker_baseAssetSymbol_fkey" FOREIGN KEY ("baseAssetSymbol") REFERENCES "Asset"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticker" ADD CONSTRAINT "Ticker_quoteAssetSymbol_fkey" FOREIGN KEY ("quoteAssetSymbol") REFERENCES "Asset"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_assetSymbol_fkey" FOREIGN KEY ("assetSymbol") REFERENCES "Asset"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_tickerSymbol_tickerMarket_fkey" FOREIGN KEY ("tickerSymbol", "tickerMarket") REFERENCES "Ticker"("symbol", "marketType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_orderListId_fkey" FOREIGN KEY ("orderListId") REFERENCES "OrderList"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderList" ADD CONSTRAINT "OrderList_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_makerOrderId_fkey" FOREIGN KEY ("makerOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_takerOrderId_fkey" FOREIGN KEY ("takerOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_makerUserId_fkey" FOREIGN KEY ("makerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_takerUserId_fkey" FOREIGN KEY ("takerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_tickerSymbol_tickerMarket_fkey" FOREIGN KEY ("tickerSymbol", "tickerMarket") REFERENCES "Ticker"("symbol", "marketType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_tickerSymbol_tickerMarket_fkey" FOREIGN KEY ("tickerSymbol", "tickerMarket") REFERENCES "Ticker"("symbol", "marketType") ON DELETE RESTRICT ON UPDATE CASCADE;
