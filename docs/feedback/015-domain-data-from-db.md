# Feedback-015: 도메인 데이터는 DB/API에서 받는다, 코드에 const로 박지 않는다

## Rule
자산·티커·주문 타입·지원 market 등 **도메인 데이터 목록**은 FE 코드에 하드코딩하지 않는다. DB에서 조회하거나 API로 노출한다. 하드코딩이 필요해 보이면 그 데이터가 정말 static UI 영역인지(예: 내비 라벨, 라우트 경로) 다시 확인.

## Why
- 새 quote 자산 추가 = FE/BE 양쪽 수정 필요 → drift + 배포 연결 지연
- FE 하드코딩은 "현재 BE 상태"와 조용히 어긋난다. 버그를 일으키지 않는 drift가 제일 위험 (예: FE에 없는 asset을 BE가 지원, 반대도)
- 단일 출처: match config → seed → DB → API → FE. 이 체인 중간에서 FE가 자의적으로 목록을 재정의하면 체인 깨짐
- 개발자 실수 빈발 지점 — "일단 const로 박고 나중에" 가 제일 자주 안 된다

## How to apply
- 예시 금지 (이런 거 FE에 const로 박지 않는다):
  - `QUOTE_ASSETS = ['USDT', ...]` → `useAllTickers()`에서 distinct quote 추출
  - `SYMBOLS = [...]` → `useAllTickers()` 결과 사용
  - `ORDER_TYPES = ['LIMIT', ...]` → BE DTO / enum 노출 엔드포인트로
  - `CHART_INTERVALS = [...]` → kline 엔드포인트가 `supportedIntervals` 반환
- 예외 (FE const OK):
  - 내비 라벨·라우트 경로
  - 테마 토큰(색, 폰트, 간격)
  - i18n 전 기본 복사문구
  - 정말 "프론트 배포 단위와 1:1 결합된" UI 설정
- 필요하면 BE에 작은 메타 엔드포인트 추가(`GET /meta/quote-assets`, `GET /meta/order-types` 등). 지연 비용보다 drift 비용이 크다
