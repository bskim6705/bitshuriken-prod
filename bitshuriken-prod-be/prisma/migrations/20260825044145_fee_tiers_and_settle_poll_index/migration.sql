-- AlterTable
ALTER TABLE "User" ADD COLUMN     "feeTier" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "SettlementEvent_status_seq_idx" ON "SettlementEvent"("status", "seq");
