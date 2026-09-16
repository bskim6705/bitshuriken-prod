-- 2026-08-25 고아 주문 정리 (유저 승인 — 비정상 종료 잔재, 감사 A7 계열)
-- 대상: 엔진 북에 없는데 DB에 open으로 남은 주문 430건 (재기동 이전 생성분 전부)과
--       그 주문들이 잠근 자금(계정별 현재 locked 전액과 일치함을 실측 대조 완료).
-- ① 주문 종결  ② 잔여 락 해제를 BalanceJournal로 기록 (원장·프로젝터가 정상 경로로 수렴).
-- 실행: docker exec -i bitshuriken-prod-postgres-1 psql -U bitshuriken -d bitshuriken < scripts/orphan-fix-2026-08-25.sql
BEGIN;

UPDATE "Order" SET status='CANCELED', "updatedAt"=now()
 WHERE status IN ('NEW','OPEN','PARTIAL');

INSERT INTO "BalanceJournal" (id, "userId", "assetSymbol", "marketType", kind, "deltaBalance", "deltaLocked", "sourceKey", meta)
SELECT gen_random_uuid()::text, w."userId", w."assetSymbol", w."marketType",
       CASE WHEN w."marketType"='SPOT' THEN 'SPOT_REFUND'::"BalanceJournalKind" ELSE 'FUTURES_REFUND'::"BalanceJournalKind" END,
       w.locked, -w.locked,
       'orphanfix:' || w."userId" || ':' || w."assetSymbol" || ':' || w."marketType",
       jsonb_build_object('note','2026-08-25 orphan-order lock release (A7 unclean-shutdown residue)')
FROM "Wallet" w JOIN "User" u ON u.id = w."userId"
WHERE w.locked > 0 AND u.email LIKE '%@bots.local';

COMMIT;
