# ADR-046: API 문서 콘텐츠를 제품별 백엔드 OpenAPI description으로 이전

## Status
Accepted (2026-06-15) — [ADR-042](042-binance-like-api-docs.md)의 #4(수작업 FE 섹션)·#5(FE 클라이언트 병합) 부분을 대체.

## Context
ADR-042는 Swagger가 못 만드는 섹션(WebSocket 스트림 / User Data Stream / 에러 코드 / 인증)을 **FE 페이지에 수작업**으로 두고, 각 앱 스펙은 FE가 클라이언트 병합하기로 했다. 그 결과:

- FE에 별도 가이드 페이지 + 본 레퍼런스와 다른 디자인이 생겨 일관성이 깨졌다 ([feedback-018](../feedback/018-api-docs-unified-per-product.md)).
- 가이드 콘텐츠는 전부 **BE 동작**(스트림 페이로드·이벤트·에러·서명)을 설명하는데 FE에 사는 게 진실 소스와 어긋났다. 실제로 FE의 에러표(`ErrorCode` 수기 mirror)는 신규 코드 9개(2FA·이메일 검증·API key 권한)를 누락해 **drift**했다 — ADR-042가 Consequence로 경고한 그대로.
- published OpenAPI(`/docs-json`)는 REST만 담긴 빈약한 문서라 FE 사이트를 안 거치는 소비자(SDK 생성·Postman·직접 호출)는 overview/WS/에러를 못 봤다.

## Decision

### 1. 가이드 콘텐츠는 제품별 OpenAPI `info.description`(마크다운)에 둔다
`libs/shared/src/docs/`에 공유 마크다운 조각(overview·auth·WS control/스트림 카탈로그/페이로드·user data)을 두고, 제품별로 조합한 `SPOT_API_DESCRIPTION` / `FUTURES_API_DESCRIPTION` / `PORTAL_API_DESCRIPTION`을 export한다. 각 앱 `main.ts`는 `.setDescription(...)`에 import해 넘긴다(main.ts는 import만, 콘텐츠는 libs/shared).
- 제품별 분기: spot(spot 스트림) / futures(+ markPrice·positionUpdate·MARGIN_CALL) / portal(WS 없음).
- WS/User Data는 REST operation이 아니라 OpenAPI로 모델링 불가 → description 마크다운으로 문서화(ADR-042 방침 유지, 위치만 BE로).

### 2. 에러표는 `ErrorCode`에서 생성 (수기 mirror 폐기)
`renderErrorCodesMarkdown()`이 `ErrorCode`를 순회해 코드·이름을 뽑고, 의미(meaning) 문자열만 colocated 맵에서 채운다. 코드/이름의 진실 소스는 `ErrorCode` 단일 — 누락 시 의미 "—"로라도 노출돼 drift가 보인다.

### 3. FE는 URL 방식으로 단순화
FE `scalar-reference.tsx`는 Scalar `sources[].url`로 각 `/docs-json`을 가져오기만 한다(클라이언트 fetch/병합·주입 로직 제거). 별도 `/api-docs/guides` 라우트와 FE 수작업 콘텐츠 모듈(`sections.tsx`·`product-docs.ts`·`error-codes-data.ts`)은 제거. 통합 레이아웃·테마(앱 팔레트)·소스 드롭다운은 유지.

## 범위 밖
- BE 측 OpenAPI 병합 애그리게이터 — 불필요. 각 앱 `/docs-json`이 자기 완결 정본이고 Scalar가 소스 드롭다운으로 전환.
- 데코레이터 커버리지(ADR-042 #3)는 그대로 유효.

## Consequences
- `/docs-json`이 자기 완결적이 된다 — FE 사이트를 안 거치는 소비자도 overview/WS/에러/인증을 받는다.
- 에러표 drift 제거. 새 `ErrorCode` 추가 시 표에 자동 반영(의미만 보강).
- 문서가 API와 같이 버전·배포된다(배포된 버전과 일치).
- WS/이벤트 등 prose는 여전히 수동 갱신이지만, 이제 BE 코드 옆(libs/shared)에 있어 변경과 가까이 산다.
- prose만 고쳐도 BE 재시작 필요(watch dev에선 자동) — 문서가 계약의 일부이므로 수용.

## 관계
- [ADR-042](042-binance-like-api-docs.md): 본 ADR이 #4·#5를 대체 (콘텐츠 위치: FE 수작업 → BE description)
- [ADR-040](040-ws-market-stream-completion.md) / [ADR-041](041-user-data-stream-enrichment.md): 문서가 보여줄 스트림·이벤트
- [ADR-019](019-api-key-with-hmac-signature.md): Auth/서명 가이드
- [feedback-018](../feedback/018-api-docs-unified-per-product.md): 제품별 단일 통합 문서 (별도 페이지 금지)
    