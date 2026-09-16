/**
 * 제품 성숙도 단계 (ADR-076). 정책 상수라 env가 아니라 코드에 둔다 (feedback-020).
 * - alpha: 내비 미노출 (직접 URL만)
 * - beta : 내비 BETA 배지 + 제품 페이지 상단 한계 배너
 * - ga   : 표시 없음
 */
export type ProductStage = "alpha" | "beta" | "ga";
export type Product = "spot" | "futures";

export const PRODUCT_STAGES: Readonly<Record<Product, ProductStage>> = {
  spot: "ga",
  futures: "beta",
};
