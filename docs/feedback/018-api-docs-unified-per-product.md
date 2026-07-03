# Feedback-018: API 문서는 제품별 단일 통합 레퍼런스 (별도 페이지/다른 디자인 금지)

## Rule
API 문서는 Binance 등 거래소 API 문서 컨벤션을 따른다. REST·WebSocket·User Data Stream·에러·인증을 제품(spot/futures/portal)별로 하나의 통합 문서에 묶고, 각 제품 overview로 시작한다. 손으로 만든 별도 페이지나 본 레퍼런스와 다른 디자인 레이아웃을 만들지 않는다.

## Why
- 별도 페이지 + 다른 디자인은 한 문서 안에서 두 개의 UI를 학습하게 만들어 일관성을 해친다
- 거래소 API 문서(Binance/OKX 등)는 제품별 단일 문서에서 overview → REST → WS → user data → 에러 순으로 통합 제공한다. 트레이더/봇 개발자는 이 패턴에 익숙하다
- 문서 콘텐츠가 제품별 한 소스에 모여야 유지보수가 단일화된다 (WS/에러를 별도 컴포넌트로 떼면 REST와 어긋나기 쉽다)

## How to apply
- Scalar 레퍼런스를 제품별 단일 문서로 유지하고, 소스 드롭다운으로 spot/futures/portal을 전환한다
- WS 스트림·user data stream·에러 카탈로그·인증은 각 제품 문서의 `info.description`(마크다운)에 통합해 Scalar 사이드바에 REST와 같은 레이아웃으로 노출한다
- 각 제품 문서는 overview로 시작한다 (base URL, 응답 envelope, auth 클래스 요약, 제품 특성)
- 내용은 제품에 맞게 분기한다 (spot: spot 스트림 / futures: + markPrice·positionUpdate·MARGIN_CALL / portal: WS 없음, auth·transfers 중심)
- 별도 `/api-docs/guides` 라우트나 bespoke 디자인 컴포넌트(예: 손으로 만든 sections 페이지)를 만들지 않는다
- 백엔드를 다른 작업자가 수정 중이면 충돌을 피해 FE에서 문서를 주입한다 (각 `/docs-json`을 받아 `info.description`을 보강해 Scalar `sources[].content`로 전달)
