// wallet mutation(deposit/withdraw/transfer) 후 invalidate 대상 쿼리 키 (transfer-modal·use-funding 공용).
export const TRANSACTIONS_KEY = ["account", "transactions"] as const;
