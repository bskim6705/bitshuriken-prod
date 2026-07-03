# ADR-016: REST 폴더는 use case 기준 (trading / account / market)

## Status
Accepted

## Context

`bitshuriken-v2-be`의 컨트롤러/서비스를 entity 기준으로 분리해 왔다 (`order/`, `wallet/`, `ticker/`). 이 방식은 초기엔 단순했지만 다음 문제가 누적된다:

- 한 entity 모듈이 read와 write를 모두 들고 있어 service가 god class로 흐름
- 인증/권한 정책이 controller 메서드마다 결정 — 누락 위험
- "Trading은 매칭엔진을 거쳐야 한다" (feedback-002)는 규칙이 폴더로 강제되지 않음
- ticker/wallet 같은 단순 entity와 order 같은 복합 entity가 같은 layer에 있어 책임 비대칭

Binance Spot REST API는 폴더를 entity가 아닌 use case로 나눈다 (General / Market Data / Trading / Account / User Data Stream). 분류 기준이 mutation 여부 + 인증 종류라서 일관성 있다. 같은 path도 verb로 그룹이 갈린다 (`POST /order`=Trading, `GET /order`=Account).

## Decision

`bitshuriken-v2-be/src` 컨트롤러 layer를 use case 기준으로 재편한다.

```
src/rest/
  trading/   # auth, mutation, 매칭엔진 emit
  account/   # auth, 자기 데이터 read
  market/    # public read
```

기존 entity 모듈(`order/`, `wallet/`, `ticker/`)은 제거. controller가 아닌 내부 모듈(`auth/`, `kafka/`, `match-result/`, `settlement/`, `prisma/`)은 그대로 유지.

URL prefix도 `/trading`, `/account`, `/market`을 사용한다. Binance는 historical 호환성 때문에 flat path지만, 새로 만드는 우리는 prefix로 가독성과 god module 방지 효과를 둘 다 챙긴다.

### 매핑

| 변경 전 | 변경 후 | 그룹 |
|--|--|--|
| `POST /orders` | `POST /trading/orders` | Trading |
| `DELETE /orders` | `DELETE /trading/orders` | Trading |
| `GET /orders/user/:userId` | `GET /account/orders` (auth에서 userId) | Account |
| `GET /orders/:id` | `GET /account/orders/:id` | Account |
| `GET /wallets/:userId` | `GET /account/wallets` | Account |
| `GET /tickers` | `GET /market/tickers` | Market |

`POST /wallets/deposit`은 임시 endpoint이므로 별도 admin path로 분리 예정 (본 ADR 범위 외).

### 분류 규칙

- **Trading**: 외부 상태(매칭엔진, wallet locked) 변경. 모듈 통째 `JwtAuthGuard`. KafkaService 의존.
- **Account**: 인증된 user의 자기 데이터 read. 모듈 통째 `JwtAuthGuard`. PrismaService만 의존. 매칭엔진/Kafka 의존 금지.
- **Market**: public read. guard 없음. PrismaService 의존. user context 사용 금지.

같은 path가 verb로 그룹이 갈리는 케이스(`/orders` GET vs POST)는 컨트롤러를 분리한다.

## Rationale

- **God service 방지**: 폴더 경계가 책임 경계와 일치. 한 service에 read/write가 섞이지 않음
- **인증 boundary 명확화**: 모듈 단위로 guard 적용 → 메서드별 누락 불가능
- **feedback-002 강제**: trading 모듈만 KafkaService를 import하므로 "order mutation은 매칭엔진 경유" 규칙이 폴더로 강제됨
- **새 기능 추가 위치 강제**: "내 fee history는 어디에?" → account. "fee 변경은 어디에?" → trading. 결정 비용 0.
- **Binance 호환성**: FE/외부 클라이언트 작성 시 Binance 학습 자원이 그대로 적용 가능
- **Wallet/Ticker 모듈 흡수**: 단순 entity 모듈이 사라지고 의도 중심으로 정리됨

## Consequences

- 모든 REST URL 변경. FE 미연동 상태이므로 외부 영향 0
- 모듈 의존성 그래프 재배치 (app.module imports 전면 교체)
- `match-result/`는 controller가 아니라 microservice handler(@MessagePattern)이므로 `rest/` 하위로 옮기지 않음
- 잠금 식 / 환불 식 같은 도메인 로직은 service가 분리되어도 정합성 유지 필요. 향후 `domain/` 폴더로 추가 분리 검토 가능 (현 단계 out of scope)
- Trading service의 트랜잭션 commit 후 Kafka emit 패턴은 그대로 유지 (zombie order는 별도 ADR/작업)

## 관계
- [feedback-002](../feedback/002-order-mutations-via-matching-engine.md): order mutation은 매칭엔진 경유 — 본 ADR이 폴더 구조로 강제
- [feedback-007](../feedback/007-single-responsibility-modules.md): 단일 책임 모듈 — use case 분리가 책임을 좁힘
- [ADR-014](014-async-settlement-via-event-log.md): match-result handler는 controller가 아니므로 본 재편 영향 없음
