-- CreateEnum
CREATE TYPE "BalanceJournalKind" AS ENUM ('SPOT_PLACE_LOCK', 'SPOT_TRADE', 'SPOT_REFUND', 'FUTURES_PLACE_LOCK', 'FUTURES_PLACE_UNLOCK', 'FUTURES_MARGIN_ADD', 'FUTURES_MARGIN_REMOVE', 'FUTURES_TRADE', 'FUTURES_REFUND', 'FUTURES_FUNDING', 'FUTURES_LIQUIDATION', 'FUTURES_INSURANCE_FUND', 'TRANSFER', 'DEPOSIT', 'WITHDRAWAL', 'ADMIN_ADJUST', 'BASELINE');

-- AlterEnum
ALTER TYPE "SettlementStatus" ADD VALUE 'QUARANTINED';

-- CreateTable
CREATE TABLE "SettlementDeadLetter" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "kind" "SettlementKind" NOT NULL,
    "legs" JSONB NOT NULL,
    "orderLegs" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL,
    "lastError" TEXT NOT NULL,
    "quarantinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementDeadLetter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BalanceJournal" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "assetSymbol" TEXT NOT NULL,
    "marketType" "MarketType" NOT NULL,
    "kind" "BalanceJournalKind" NOT NULL,
    "deltaBalance" DECIMAL(32,8) NOT NULL DEFAULT 0,
    "deltaLocked" DECIMAL(32,8) NOT NULL DEFAULT 0,
    "sourceKey" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BalanceJournal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SettlementDeadLetter_eventId_key" ON "SettlementDeadLetter"("eventId");

-- CreateIndex
CREATE INDEX "SettlementDeadLetter_quarantinedAt_idx" ON "SettlementDeadLetter"("quarantinedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BalanceJournal_seq_key" ON "BalanceJournal"("seq");

-- CreateIndex
CREATE UNIQUE INDEX "BalanceJournal_sourceKey_key" ON "BalanceJournal"("sourceKey");

-- CreateIndex
CREATE INDEX "BalanceJournal_userId_assetSymbol_idx" ON "BalanceJournal"("userId", "assetSymbol");

-- CreateIndex
CREATE INDEX "Trade_makerOrderId_idx" ON "Trade"("makerOrderId");

-- CreateIndex
CREATE INDEX "Trade_takerOrderId_idx" ON "Trade"("takerOrderId");
