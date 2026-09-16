# bitshuriken-prod-be

Bitshuriken 거래소 백엔드 — Nest.js 모노레포(apps + libs), Prisma(단일 Postgres), Kafka. 매칭은 별도 Python 엔진이 하고 BE는 접수·잠금·정산·계정·API를 담당한다. 시스템 계약은 상위 [CLAUDE.md](../CLAUDE.md), 코드 컨벤션은 [CLAUDE.md](CLAUDE.md).

## 프로세스

| 앱 | 포트 | 역할 |
| --- | --- | --- |
| `apps/spot` | 5101 | 현물 주문·계정·마켓 데이터·WS(`/ws/market`, `/ws/user`) |
| `apps/futures` | 5102 | 무기한 선물 — 마진·포지션·mark price·펀딩·청산·보험기금·WS |
| `apps/portal` | 5103 | cross-product — 인증·API key·이체·리더보드·서브계정·관리자 |
| `apps/settle` | 5104 | 정산 프로세스([ADR-077](../docs/adr/077-settlement-process-split-and-graceful-shutdown.md)) — 엔진 out 토픽의 DB 효과, 양 마켓 정산 워커, DLQ, 원장 레플리카·프로젝터. HTTP는 `/health`뿐 |

`libs/shared`(decimal·예외·상수·WS 베이스), `libs/infra`(Kafka·Prisma), `libs/core-domain`(auth·user·wallet·ledger·ticker·orderbook·kline)을 네 앱이 공유한다. 이미지는 하나이고 `command`만 다르다.

## 핵심 설계

- 주문 mutation은 반드시 매칭엔진 경유. BE는 체결·취소 상태를 직접 만들지 않는다.
- 잔고의 진실은 인메모리 원장 + append-only `BalanceJournal`이고 `Wallet` 행은 프로젝션이다([ADR-069](../docs/adr/069-in-memory-balance-ledger.md)). 접수 응답은 저널 커밋 후에만 나간다.
- 정산은 append-only `SettlementEvent`를 워커가 `seq` 순으로 적용한다([ADR-014](../docs/adr/014-async-settlement-via-event-log.md), [ADR-032](../docs/adr/032-futures-settlement-state-machine.md)). poison 이벤트는 5회 후 DLQ로 격리([ADR-067](../docs/adr/067-settlement-dead-letter-queue.md)).
- 금액은 `Decimal` 8자리, Kafka 경계는 scaled-int string. 라운딩은 `libs/shared/src/decimal.ts`만.

## 실행

```bash
npm install
cp .env.example .env          # PORT_SPOT/FUTURES/PORTAL/SETTLE, DATABASE_URL(5110), KAFKA_BROKER(5113)
npx prisma migrate deploy      # 스키마 변경은 schema.prisma만 수정하고 migrate는 사람이 실행
npm run build                  # nest build spot/futures/portal/settle
npm run start:prod:spot        # :futures / :portal / :settle
```

전체 스택은 루트 `./scripts/exchange.sh start`가 정본이다(빌드 후 dist 실행, `--watch` 금지).

## 테스트

```bash
npm test                # jest 유닛 — 순수 생성자 mock, DB 불필요 (42 suites / 419 tests)
npm run test:e2e        # test/*.e2e-spec.ts — 실 DB 필요
npx tsc --noEmit -p tsconfig.build.json
```

정합성 검증(F1~F5: 장부 대사·청산 오라클·선물 원장·frozen·DLQ)은 `bitshuriken-prod-bots`의 `check-integrity`가 담당한다.
