-- AlterEnum
ALTER TYPE "AssetType" ADD VALUE 'FIAT';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "rateLimitExempt" BOOLEAN NOT NULL DEFAULT false;
