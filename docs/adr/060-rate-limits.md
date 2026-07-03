# ADR-060: Binance 스타일 weight 기반 rate limit

## Status
Accepted (Phase 1 구현 — enforcement는 기본 off로 출시)

## Context
거래소 API에 남용/폭주 방어가 없다. Binance를 미러링하므로 Binance의 weight 모델을 그대로 따른다:
엔드포인트마다 가중치(weight)가 있고, IP/계정별 분당 weight 예산을 초과하면 `429 + Retry-After`,
주문 수는 별도 버킷(10s/1d)으로 카운트한다. 클라이언트가 스스로 throttle 할 수 있도록 매 응답에
`X-MBX-USED-WEIGHT-1M` / `X-MBX-ORDER-COUNT-*` 헤더를 실어 보낸다.

제약:
- BE는 Nest 모노레포 — `apps/{spot,futures,portal,dex,options}`가 **각각 별도 프로세스**(별도 host:port)다.
  프로세스 간 공유 메모리가 없다.
- 인프라에 Redis가 없다 (Postgres + Kafka + Mailpit).
- 봇/에이전트/무결성 하니스가 REST를 두드리며, 현재 어느 쪽도 `429`/`Retry-After`를 처리하지 않는다.
- FE는 5개 BE 포트에 모두 cross-origin이다.

## Decision
**인프로세스, 앱별 독립 limiter**를 `libs/shared/src/rate-limit`에 두고, 각 AppModule이 import하는
`RateLimitModule`에서 `APP_INTERCEPTOR`로 등록한다. 신규 의존성/마이그레이션 없음.

1. **가드 아닌 인터셉터.** 글로벌 `APP_GUARD`는 컨트롤러 `@UseGuards(PrivateGuard)`보다 **먼저** 실행돼
   `req.user`가 비어 주문이 IP로 잘못 버킷된다. 인터셉터는 가드 **뒤**에 실행되므로 `req.user`(userId)를 읽을 수 있다.
2. **신원.** weight/raw = 인증 시 `acct:<userId>`, 익명 시 `ip:<req.ip>`. order count = 항상 `acct:<userId>`.
   (Binance: weight=IP, orders=계정.)
3. **앱별 독립 풀.** 5개 프로세스가 카운터를 공유하지 않는다. 이는 Binance가 spot(6000/min)과
   fapi(2400/min) weight 풀을 물리적으로 분리 운영하는 것과 **일치**하는 충실한 미러다 — 절충이 아니다.
4. **헤더 방출은 인터셉터가 응답 객체에 직접 `setHeader`** (pre-handler 단계). 성공(2xx)·거부(429) 응답 모두
   같은 res 객체를 쓰므로 한 곳에서 처리된다. `HttpExceptionFilter`/`ResponseInterceptor`는 무수정.
5. **거부 = 429.** `RateLimitException`(RATE_LIMITED) / `TooManyOrdersException`(TOO_MANY_NEW_ORDERS),
   둘 다 `DomainException` 상속. `Retry-After` + used-weight 헤더를 거부 응답에도 싣는다.
6. **CORS exposedHeaders 필수.** 5개 앱 `enableCors()`에 rate-limit 헤더를 노출하지 않으면 cross-origin FE가
   전부 `null`로 읽어 FE 절반이 무력화된다. 공통 부트스트랩 `applyGlobalPipeline(app)`로 일괄 적용.
7. **면제는 `X-Internal-Token` 단일 경로.** 토큰 일치 시에만 면제 — 인증 없이 동작하므로 공개 market 엔드포인트도 커버한다.
   봇/에이전트/하니스는 모든 요청에 토큰 첨부. (이메일 allowlist 2순위 경로는 제거 — 토큰으로 단일화, 더 단순. 미설정이면 면제 없음.)
8. **trust proxy 기본 0.** 역프록시가 없는 dev/demo에서 `X-Forwarded-For`를 신뢰하면 `req.ip`가 스푸핑된다.
   역프록시 뒤일 때만 `RATE_LIMIT_TRUST_PROXY_HOPS`를 hop>0으로.
9. **인메모리 저장소 수명/한계.** TTL sweep `setInterval`은 `onModuleDestroy`에서 정리(hot-reload/테스트 누수 방지),
   Map은 `RATE_LIMIT_STORE_MAX_KEYS` 상한 + 오래된 키 LRU 축출(다수 IP 폭주 OOM 방지). `RateLimitStore`
   인터페이스 뒤에 두어 스케일아웃 시 공유 저장소로 교체 가능.

### 잠긴 정책 (유저 확정)
- 한도 = Binance 기본값: spot 6000 weight/min, futures 2400/min, portal·dex·options 6000/min,
  raw 61000/5min, orders 100(futures 300)/10s + 200000/1d.
- **418 IP-ban = OFF.** 429에서 멈춘다 (시뮬/데모 거래소에 IP ban은 과함).
- 앱별 독립 풀.
- BE 멱등 dedupe = v1 제외 (FE는 동시 더블클릭 코얼레싱 + 버튼 isPending으로 방어, `Idempotency-Key`는 헤더 전용 forward-compat).

## Rationale
- A안(인프로세스)이 `@nestjs/throttler`(요청 수만 셈, weight 아님)와 Redis/Postgres 공유 저장소(단일 인스턴스에
  불필요한 cross-process 정합성 + hot-path 지연/경합)를 모두 이긴다. weight 산정이 hot path(taker ~8 order/s)에
  네트워크/DB 왕복을 더하지 않는다.
- DEX는 매칭엔진을 우회하는 동기 REST다 — `@OrderCount`(엔진 주문 시맨틱) 부적용, plain REST weight로 취급.

## Consequences
- 카운터는 휘발성·단일 인스턴스 한정. **스케일아웃 경계**: 한 앱이 replica >1이면 카운터가 분기해 유효 한도가 N배가 된다.
  넘으려면 `RateLimitStore` 구현만 공유 저장소(Redis INCR / Postgres atomic upsert)로 교체 — 인터셉터/데코레이터 무변경.
- 신규 Prisma 마이그레이션 0, 신규 의존성 0 (env 기반).
- WS 연결/스트림/메시지 한도는 v1 범위 밖(후속). v1은 FE의 무효화 디바운스 + 재연결 지터로 WS 구동 부하를 줄인다.
- Phase 1은 `RATE_LIMIT_ENABLED=false`로 출시 — 헤더/`rateLimits[]`/CORS는 방출하되 거부는 안 함. FE가 헤더에
  맞춰 빌드된 뒤 봇/에이전트/하니스 백오프가 들어가면 demo 프로파일에서만 켠다.
