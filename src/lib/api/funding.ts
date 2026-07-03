import { portalApi } from "./client";

export interface FundingReq {
  assetSymbol: string;
  qty: string;
  /** 6-digit TOTP code — sent for withdrawals when the account has 2FA enabled. */
  totpCode?: string;
}

export interface DepositRes {
  depositId: string;
  assetSymbol: string;
  qty: string;
  marketType: "SPOT";
}

export interface WithdrawalRes {
  withdrawalId: string;
  assetSymbol: string;
  qty: string;
  marketType: "SPOT";
}

// dev 입출금 — 체인 없이 SPOT 지갑 즉시 가산/차감
export async function createDeposit(req: FundingReq): Promise<DepositRes> {
  return portalApi.post<DepositRes>("/account/deposits", { ...req });
}

export async function createWithdrawal(req: FundingReq): Promise<WithdrawalRes> {
  return portalApi.post<WithdrawalRes>("/account/withdrawals", { ...req });
}
