# ADR-042: Binance식 통합 API 문서 페이지 (Scalar)

## Status
Accepted (2026-06-14)

## Context
문서화 감사 결과:
- `@nestjs/swagger`는 설치돼 있고 세 앱이 각자 `/docs`(5101/5102/5103)에 Swagger UI를 서빙하지만, **DocumentBuilder가 빈약** — title/version만, **security scheme 미등록**이라 `@ApiBearerAuth`의 Authorize 버튼이 죽어 있고, `@ApiResponse`/`@ApiQuery`/`@ApiParam`이 **전무**(파라미터·응답·예시 미문서화).
- **FE 랜딩의 "Open Swagger →"가 `/api/docs`(404)** 를 가리키는 죽은 링크.
- **WS 스트림은 어디에도 문서화 안 됨**(Swagger가 WS를 모델링 못 함). 통합 페이지 없음(3개 분산).
- FE는 세 앱을 5101/5102/5103로 직접 호출(프록시/게이트웨이 없음).

페이로드는 [ADR-040](040-ws-market-stream-completion.md) 정책대로 **실제 named 페이로드**를 문서화한다(byte-for-byte Binance 아님). "Binance like"는 **페이지 구성·범위·스트림 카탈로그** 수준.

## Decision

### 1. 단일 FE 문서 라우트 + Scalar
FE에 `/api-docs` 라우트를 만들고 **Scalar**로 렌더한다. 랜딩의 죽은 `/api/docs` 링크를 이 라우트로 교정(리다이렉트 또는 직접 링크). 세 앱(spot/futures/portal)의 OpenAPI를 한 페이지에서 제공 — Scalar의 multi-source(제품 전환) 또는 병합. 각 operation은 제품 태그 + base URL(addServer)로 출처를 명시.

### 2. DocumentBuilder 보강 (세 앱 main.ts)
- `setDescription` + `addServer`(각 앱 base URL, dev 포트 명시).
- **security scheme 등록**: `addApiKey`(X-API-Key + HMAC 서명 흐름) + `addCookieAuth`(`bs_session`) — 실제 인증(쿠키 세션 + API-key 서명)과 일치, Authorize 동작.
- `jsonDocumentUrl`로 raw 스펙(`/docs-json`) 노출 → FE가 fetch/병합. CORS는 기존 `CORS_ORIGINS` 허용.

### 3. 데코레이터 커버리지 패스
컨트롤러/DTO에 `@ApiTags`(전 컨트롤러), `@ApiOperation`, GET에 `@ApiQuery`/`@ApiParam`, 응답에 `@ApiResponse`(예시 바디 또는 응답 DTO). Binance식 "endpoint = verb+path / 파라미터 표 / 응답 예시 / auth class" 정보가 스펙에 담기도록.

### 4. Swagger가 못 만드는 섹션은 수작업으로 (같은 FE 페이지)
- **WebSocket Streams 카탈로그**: `/ws/market`·`/ws/fmarket` 전 스트림(이름 템플릿·페이로드 샘플·cadence) + SUBSCRIBE/UNSUBSCRIBE JSON 프로토콜 + `{stream,data}` 엔벨로프. spot/futures 구분, futures 전용(@markPrice 등) 표시. ADR-040의 신규 스트림 포함.
- **User Data Stream**: listenKey 라이프사이클(POST/PUT/DELETE, 60분 만료+keepalive, 듀얼 인증) + 전 이벤트(executionReport/outboundAccountPosition/listStatus/positionUpdate + 신규 listenKeyExpired/MARGIN_CALL, ADR-041) 페이로드 샘플.
- **에러 코드 표**: `libs/shared/src/constants/error-codes.ts`의 `ErrorCode`/`DomainException` 카탈로그.
- **Auth/서명 가이드**: 쿠키 세션 + API-key HMAC-SHA256 서명(ADR-019).

### 5. 환경/포트
FE는 dev에서 `NEXT_PUBLIC_API_URL`(5101)·`NEXT_PUBLIC_FUTURES_API_URL`(5102)·portal URL에서 스펙을 가져온다. 새 env가 필요하면 deployment-variant로만 추가(feedback-013).

## 범위 밖
- BE 측 OpenAPI 병합 애그리게이터(4번째 서비스) — FE 클라이언트 병합으로 충분, 각 앱 스펙을 정본으로 유지.
- byte-for-byte Binance 페이로드(ADR-040에서 기각). try-it-out의 서명 자동화는 best-effort.

## Consequences
- 작동하는 단일 개발자 진입점이 생기고 죽은 링크가 사라진다. REST + WS + 인증 + 에러가 한 페이지에.
- 세 앱 스펙은 각자 정본 유지(FE가 클라이언트 병합) — 앱별 진실 소스 분산 유지.
- 데코레이터 보강은 다수 컨트롤러/DTO를 건드리지만 전부 additive(런타임 동작 불변, 메타데이터만).
- WS/에러/인증 섹션은 수작업이라 스트림/이벤트 추가 시 동기 갱신 의무(문서에 명시).

## 관계
- [ADR-040](040-ws-market-stream-completion.md): 문서가 보여줄 named 페이로드 + 신규 마켓 스트림
- [ADR-041](041-user-data-stream-enrichment.md): User Data Stream 섹션의 신규 이벤트
- [ADR-019](019-api-key-with-hmac-signature.md): API-key HMAC 서명 — Auth 가이드 + security scheme
- [ADR-016](016-rest-folder-by-use-case.md): REST 표면 구조 — 문서 태깅 기준
- [feedback-013](../feedback/013-env-only-deployment-variant.md): 새 env는 deployment-variant만
