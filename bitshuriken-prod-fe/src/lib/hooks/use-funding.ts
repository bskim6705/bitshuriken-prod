"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createDeposit, createWithdrawal, type FundingReq } from "@/lib/api/funding";
import { TRANSACTIONS_KEY } from "./use-transactions";

const SPOT_BALANCES_KEY = ["spot", "balances"] as const;

export function useDeposit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: FundingReq) => createDeposit(req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SPOT_BALANCES_KEY });
      void qc.invalidateQueries({ queryKey: TRANSACTIONS_KEY });
    },
  });
}

export function useWithdraw() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: FundingReq) => createWithdrawal(req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: SPOT_BALANCES_KEY });
      void qc.invalidateQueries({ queryKey: TRANSACTIONS_KEY });
    },
  });
}
