# feedback-017: market은 비로그인 공개, private 액션에서만 로그인 유도

## Rule
시세·오더북·체결·kline 등 market 데이터(페이지·API·WS)는 로그인 없이 항상 보여야 한다. 로그인 요구는 주문 제출, 잔고/포지션 조회, API key 관리 등 private 액션을 실제로 시도하는 시점에만 발생시키고, 그때 로그인 화면으로 유도한다.

## Why
거래소의 표준 UX다 — 시세는 공개 데이터이고, 비로그인 사용자가 차트와 호가를 둘러보는 것이 자연스러운 첫 진입 경로다. 페이지 단위로 로그인을 강제하면 공개 데이터까지 막혀 진입 장벽이 되고, public/private 경계가 라우트가 아닌 액션 단위라는 BE 설계(market은 public, trading/account만 guard)와도 어긋난다.

## How to apply
- FE: market 페이지·컴포넌트는 인증 없이 렌더. private 데이터 영역(잔고, 오픈오더, 포지션 등)은 비로그인 시 로그인 유도 UI로 대체하고, 주문 등 private 액션 시도 시 로그인 화면으로 이동시킨다.
- FE: private API의 401 응답을 전역에서 로그인 유도로 처리하되, market 데이터 호출은 영향받지 않게 분리한다.
- BE: market REST/WS는 guard 없이 public 유지 (현행 설계 그대로).
