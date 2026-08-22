# bitshuriken-prod-be

Bitshuriken 백엔드 — Nest.js 모노레포. spot·futures 거래 API + Kafka producer/consumer. (시스템 개요·서비스 간 계약은 상위 `../CLAUDE.md`.)

## Structure
- `apps/spot` (port 5101) — spot 거래
- `apps/futures` (port 5102) — futures 거래 (마진/포지션/펀딩/청산/보험기금)
- `apps/portal` (port 5103) — cross-product: `/auth`, api-key, `/account/transfers`, admin, 리더보드, 서브계정, 보안(세션/로그인이력/안티피싱). REST 전용(Kafka는 admin ticker control produce만)
- `libs/shared` (`@app/shared`) — decimal 헬퍼, DomainException/ErrorCode, WS 베이스, 상수(error-codes, trading-protection), 데코레이터
- `libs/infra` (`@app/infra`) — Kafka, Prisma, messaging topics
- `libs/core-domain` (`@app/core-domain`) — auth·2FA·mail·api-key·user·wallet·ticker·orderbook·kline
- `prisma/schema.prisma` — 단일 DB, `MarketType = SPOT | FUTURES`

## Prisma (중요)
- 스키마 변경은 `prisma/schema.prisma`만 수정한다. **마이그레이션 파일을 직접 만들거나 `migrate` 명령을 실행하지 않는다** — 유저가 `npx prisma migrate dev --name <이름>`을 돌린다.
- 스키마 문법 확인은 `npx prisma validate`, 클라이언트 생성은 `npx prisma generate`.

## 코드 컨벤션 (2026-06 확정)
- **주문 mutation은 매칭엔진 경유 필수** (docs/feedback/002). 주문 접수 시 즉시 PENDING/NEW 상태로 응답 (docs/feedback/004).
- 네이밍: spot 대응물이 있는 futures 클래스만 `Futures` 풀 prefix(F 축약 금지). futures 고유 개념(MarkPrice/Position/Liquidation 등)은 prefix 없음.
- 메서드 동사: `onX(listener)` = 구독 등록(해제 함수 반환), `fanoutX` = 이벤트 구동 송출, `broadcastX` = 타이머 구동 송출.
- 에러: 생 HttpException 금지 — `DomainException(ErrorCode, message)` (`libs/shared/src/exceptions`). ErrorCode는 의미 단위 재사용, 신규는 `libs/shared/src/constants/error-codes.ts` + `docs/error-codes-doc.ts`.
- 금액: 라운딩·스케일 변환은 `libs/shared/src/decimal.ts` 헬퍼만 (지급 floor8 / 차감 ceil8, Kafka 경계는 to/fromScaledIntString). Precision 표는 `../CLAUDE.md`.
- WS: 게이트웨이는 `libs/shared/src/ws` 베이스 상속.
- spot↔futures 중복: 복제 허용, 공통 추출은 두 구현이 모두 검증된 후에만 (ADR-017). 정산 worker는 의미론이 달라 통합 금지.
- 정책 상수(가격밴드·주문상한 등)는 `.env` 아니라 `libs/shared/src/constants/trading-protection.ts` (docs/feedback/020).
- 조용히 default/에러 삼키지 않기 — fail loudly (docs/feedback/014). 함부로 default 값 쓰지 말 것 (docs/feedback/005).
- 주석: 핵심만 짧게 self-contained, ADR 번호 코드에 안 박음 (docs/feedback/009). ADR/피드백은 상위 `../docs/`.

## Test / build
```bash
npm run build          # webpack: spot + futures + portal
npm test               # jest 유닛 (plain 생성자 mock 패턴)
npm run test:e2e       # test/*.e2e-spec.ts — 실 DB 필요(migrate 후)
npm run start:dev:spot # / :futures / :portal  (.env에 PORT_SPOT/FUTURES/PORTAL 필수)
```
유닛 spec은 `new Service(...mocks)` 순수 생성자 패턴(TestingModule 미사용). 순수 검증 함수(order-validation, margin-math)는 별도 pure spec.
