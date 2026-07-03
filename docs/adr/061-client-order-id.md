# ADR-061: clientOrderId (클라이언트 지정 주문 id)

## Status
Accepted (2026-06-18)

## Context
Binance 파리티 전수조사에서 최우선 갭으로 `clientOrderId` 전면 부재가 식별됐다(Binance API gap 분석, Phase 1). 주문은 BE 내부 uuid로만 주소 지정 가능해 ① 멱등 배치(중복 제출 방지), ② 클라이언트 측 주문 추적, ③ Binance SDK류 클라이언트 호환의 전제가 막혀 있었다. spot/futures/options는 단일 `Order` 테이블을 공유한다(ADR-015).

## Decision
1. **`Order.clientOrderId String?` 단일 컬럼**(3개 상품 공유 테이블). 요청 필드는 Binance 명명 그대로: 생성 `newClientOrderId`, 취소/조회 `origClientOrderId`. 응답·executionReport 필드는 `clientOrderId`.
2. **미지정 시 BE 자동생성**(Binance 동일) — `generateClientOrderId()`(uuid, 패턴 `^[A-Za-z0-9_.-]{1,36}$` 만족). 검증은 `@Matches(CLIENT_ORDER_ID_PATTERN)`. 공통 헬퍼는 `libs/shared/src/order-client-id.ts`.
3. **유니크 범위 `@@unique([userId, tickerMarket, clientOrderId])`** — 같은 상품 내 재사용 금지(종결 후 포함), 상품 간 독립. Binance(오픈 주문 한정 유니크, 종결 후 재사용 허용)보다 엄격하지만 partial index 불필요·경합 안전. 중복은 `ORDER_DUPLICATE_CLIENT_ID(40016)`.
4. **DB unique 제약이 동시성 안전장치** — 사전 SELECT 검사 없이 insert 후 P2002를 `createOrderOrThrowDuplicate()`가 DomainException으로 변환(경합 패자도 깔끔한 에러).
5. **BE-only — Kafka 경계를 넘지 않음**. 매칭엔진은 `id`(uuid)만 안다. clientOrderId는 BE 라벨이라 NO/CO 메시지·엔진 무변경. 응답/executionReport는 BE가 join으로 echo.
6. **주소 지정은 기존 `:id` 라우트 다형 해석**(신규 라우트 모양 추가 없음): id(uuid) findUnique 우선, 미스 시 본인+상품 scope `clientOrderId` findFirst 폴백. 기존 소유권/마켓 게이트 의미론 보존(타인 주문 uuid→FORBIDDEN/NOT_FOUND 유지). cancel·query(spot/futures/options) 공통.
7. **Futures 단건 조회 신규**: `GET /futures/account/orders/:id`(id 또는 clientOrderId). spot은 기존 라우트 보유, options는 후속(preview).

## 범위 밖 (후속)
- Binance wire-호환 numeric `orderId`(int64) 전환 — uuid 스킴·ADR-038(deterministic trade id)·FE·전 응답 영향이라 별도 ADR.
- WS 트레이딩 API(`order.place/cancel`)·options WS executionReport(preview).
- cancel-replace의 `cancelOrigClientOrderId`(spot `replacesOrderId`는 uuid 유지).

## Consequences
- 마이그레이션 필요(컬럼+유니크 인덱스) — 유저가 `npx prisma migrate dev` 실행. 기존 행은 `clientOrderId=null`(NULL은 유니크에서 distinct).
- DTO/응답이 additive-only라 FE·봇 무변경(옵셔널 필드). 봇은 자동생성 id 수신.
- 멱등성은 "같은 clientOrderId 재제출 거부"로 제공 — Binance식 "동일 파라미터면 같은 주문 반환"은 아님(거부 모델).
