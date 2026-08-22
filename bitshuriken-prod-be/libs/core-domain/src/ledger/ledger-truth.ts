/**
 * ADR-069 S2 truth 스위치. true면 잔고 진실이 인메모리 원장이고 Wallet 행은 읽기 프로젝션이 된다
 * (핫패스에서 Wallet 행 UPDATE 제거 — 락 컨보이 수술). false면 전 경로가 S0 섀도 동작과 바이트
 * 동일(원장은 병행 기록만, Wallet 행이 진실). 한 줄 플립 + 재빌드로 가역 롤백. .env 아님(feedback-020).
 *
 * 배선 규율: 소비자는 이 상수 단독이 아니라 `LEDGER_TRUTH && LedgerAvailability.enabled`로 판정한다
 * — LEDGER_TRUTH이지만 저널 테이블 부재면 진실을 영속할 수 없으므로 S0 행 경로로 안전 강등.
 */
export const LEDGER_TRUTH = true;
