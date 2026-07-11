# Bitshuriken (production)

spot·futures 완성도에 집중하는 시뮬레이션 거래소. `bitshuriken-v2`의 시맨틱 포크 — options/dex/bots/agents/mcp 제외 (경위: [docs/adr/065](docs/adr/065-production-fork.md)). "prod는 실거래소 기준으로 판단한다" (docs/feedback/024).

각 서비스는 독립 git 레포이며 자기 CLAUDE.md를 갖는다. 이 문서는 시스템 전체 계약과 공유 규칙만 다룬다.

## Services
| repo | 역할 | port |
| --- | --- | --- |
| [bitshuriken-prod-be](bitshuriken-prod-be/) | Nest.js — apps/{spot, futures, portal} + libs | 5101 / 5102 / 5103 |
| [bitshuriken-prod-fe](bitshuriken-prod-fe/) | Next.js 프론트엔드 | 5100 |
| [bitshuriken-prod-match](bitshuriken-prod-match/) | Python 매칭엔진 (Lane 패턴) | — (Kafka) |
| [bitshuriken-prod-infra](bitshuriken-prod-infra/) | 프로드 배포 (compose + nginx) | 80/443 |

## 서비스 간 계약 (연결부)
- **BE ↔ 매칭엔진**: Kafka 토픽 `match.{spot|futures}.{in|out|book|state|control}`. 메시지 본문 `op` 필드로 종류 구분 (NO/CO/TR/OU/DPD). 주문 mutation은 반드시 매칭엔진 경유 — BE가 직접 체결/취소 상태를 만들지 않는다 (docs/feedback/002).
- **파티션**: 심볼 → 버킷 = FNV-1a(symbol) % P (P = `MATCH_*_PARTITIONS`, 기본 6). BE·infra·엔진이 P를 동일하게 유지해야 lane↔partition 매핑이 안 깨진다 (ADR-063).
- **FE ↔ BE**: 같은 오리진 `/api/*`를 nginx가 앱별로 라우팅(prod) / dev는 포트 직결. FE는 `NEXT_PUBLIC_{API,FUTURES_API,PORTAL_API}_URL`로 주소를 받는다.
- **인증**: 발급(로그인)은 portal, 검증(가드)은 전 앱 — 세션 쿠키 + `JWT_SECRET` 공유.

## Precision rules (be·match 공유)
| 위치 | 표현 | 비고 |
| ---- | ---- | ---- |
| 사람이 보는 값 | "50000.00" / "0.10000000" | 소수점 8자리 |
| BE 내부 (Prisma) | `Decimal` | DB 저장 |
| Kafka 메시지 | string (`* 10^8` 정수의 string) | JSON safe int (ADR-005) |
| 매칭엔진 내부 | int (`* 10^8`) | 항상 floor, 부동소수점 금지 |
| stepSize / tickSize | int (`10^(8 - precision)`) | OrderBook이 보유 |

변환 지점: BE↔메시지(Decimal ↔ scaled-int string), 메시지↔엔진(string ↔ int). MARKET BUY(quote-driven)는 floor stepSize 후 잔여를 dust로 BE가 환불.

## Docs (이 우산에 위치)
- [docs/adr/](docs/adr/) — 아키텍처 의사결정. 새 결정 발생 시 `docs/adr/NNN-제목.md` (Status/Context/Decision/Rationale/Consequences). 번호 순차 증가, 다음은 066. 코드 주석에 ADR 번호 박지 않는다.
- [docs/feedback/](docs/feedback/) — 유저 교정/피드백. **즉시 기록**: No/다른 방향 지시를 받으면 다음 작업 전에 먼저 `docs/feedback/NNN-제목.md` 작성 (Rule/Why/How to apply).
- [docs/specs/](docs/specs/) — 구현 플랜/관찰. `refactor-observations.md`에 오픈 버그(취소 레이스·trigger dead path 등) 기록.

## 공통 작업 규칙
- 요청한 범위만. 미리 구현 금지 (docs/feedback/001). 검증 안 된 코어 위에 큰 기능 미리 쌓지 않기 (docs/feedback/019).
- 정책 결정(마진모드/마크/청산/펀딩/보험기금/레이트리밋 등)은 유저 확정 후 (docs/feedback/016).
- 정책·상수성 설정은 .env 아니라 코드/DB (docs/feedback/020). 런타임 조회 가능한 목록은 하드코딩 금지 (docs/feedback/021).
- 주석은 핵심만 짧게, self-contained (docs/feedback/009).

## How to run (전체 스택)
```bash
docker compose up -d      # postgres 5110 / kafka 5113 / mailpit 5111 등 (dev 인프라)
./scripts/up.sh           # BE 3앱 + match + FE 일괄 (Ctrl-C 종료 / ./scripts/down.sh)
```
최초 1회(fresh DB): `cd bitshuriken-prod-be && npm install && npx prisma migrate dev --name init && npx prisma db seed`.
개별 서비스 실행/컨벤션은 각 서브레포 CLAUDE.md 참조.
