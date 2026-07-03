# ADR-024: User Data Stream — WS /ws/user, 쿠키 + listenKey 이중 인증

## Status
Accepted

## Context

주문 상태/체결/잔고 변경의 실시간 푸시(Binance executionReport / outboundAccountPosition 상당)가 없으면 FE가 폴링해야 한다. 요구사항:
- 웹(쿠키 세션)과 API 사용자(HMAC 키, ADR-019) 둘 다 연결 가능해야 한다.
- market 게이트웨이는 무인증 공개 스트림 — 사용자 스트림은 별도 인증 경로 필요.
- cookie-parser는 Express 미들웨어라 WS upgrade 요청에는 돌지 않는다.

## Decision

1. **별도 게이트웨이 `/ws/user`** (market과 분리). 연결 즉시 push 시작, 구독 프로토콜 없음. 메시지 `{stream, data}` — `executionReport` / `outboundAccountPosition` / `listStatus`.
2. **인증 (upgrade 시 1회)**:
   - 웹: upgrade 요청의 `Cookie` 헤더를 직접 파싱해 `bs_session` JWT 검증 + Origin을 CORS_ORIGINS와 대조.
   - API: `?listenKey=` — `POST /spot/user-data-stream`(PrivateGuard)으로 발급, TTL 60분, PUT keepalive / DELETE 즉시 만료 (Binance listenKey 라이프사이클). 만료/폐기 시 해당 소켓 close(4401). upgrade URL은 로깅 금지.
   - REST는 account가 아닌 **전용 컨트롤러 `/spot/user-data-stream`** — ADR-016의 account(read-only, Prisma만) 순수성 유지. Binance도 User Data Stream을 별도 그룹으로 분류.
3. **이벤트 소스**:
   - executionReport: 모든 OU 수신마다 (eq/cqq는 OU 메시지 값 — DB는 worker 비동기라 stale), 주문 생성 직후, 트리거 arming, BE 로컬 취소 시.
   - outboundAccountPosition: 잔고를 **쓰기 트랜잭션 안에서 캡처** (사후 SELECT는 순서 역전), `Wallet.updatedAt`을 ts로 실어 FE가 자산별 max(ts)로 stale drop.
   - 재연결 시 스냅샷 없음 — FE가 (재)연결마다 REST 재동기화 (react-query invalidate).
4. **단일 BE 인스턴스 전제**: emitter/listenKey/소켓 맵 전부 in-memory. 다중 인스턴스에서는 이벤트가 파티션 소유 인스턴스에서만 발생해 유실된다 — 수평 확장 시 Redis pub/sub 등으로 이행 필요.

## Rationale

- 쿠키 인증은 웹에서 토큰 노출 없이 공짜로 얻어진다 (단, FE/BE 동일 registrable domain 필요 — SameSite=Lax는 cross-site WS handshake에 쿠키를 싣지 않음).
- listenKey는 Binance 표준이라 API 사용자 도구와 호환.

## Consequences

- FE는 user-ws onOpen마다 `['spot',…]` 쿼리 무효화로 끊김 구간을 복구한다 — 이벤트 replay 없음.
- 단일 인스턴스 제약이 명문화됨.
- canTrade/canRead 강제는 ADR-019 시퀀싱대로 여전히 미구현 (보안 타입 표기만).
