# Bitshuriken (production)

spot·futures 완성도에 집중하는 시뮬레이션 거래소. `bitshuriken-v2`의 시맨틱 포크 — 코어 런타임에서 options/dex/mcp 제외, bots/agents는 외부 전략 테스트 서비스로 포함 (경위: [docs/adr/065](docs/adr/065-production-fork.md)). "prod는 실거래소 기준으로 판단한다" (docs/feedback/024).

전체는 단일 Git 모노레포다(ADR-071). 서비스별 의존성·빌드·배포 단위는 독립적으로 유지하며, 이 문서는 시스템 전체 계약과 공유 규칙을 다룬다.

## Services
| repo | 역할 | port |
| --- | --- | --- |
| [bitshuriken-prod-be](bitshuriken-prod-be/) | Nest.js — apps/{spot, futures, portal} + libs | 5101 / 5102 / 5103 |
| [bitshuriken-prod-fe](bitshuriken-prod-fe/) | Next.js 프론트엔드 | 5100 |
| [bitshuriken-prod-match](bitshuriken-prod-match/) | Python 매칭엔진 (Lane 패턴) | — (Kafka) |
| [bitshuriken-prod-infra](bitshuriken-prod-infra/) | 프로드 배포 (compose + nginx) | 80/443 |
| [bitshuriken-prod-bots](bitshuriken-prod-bots/) | 미러링·정합성·부하 테스트 | — |
| [bitshuriken-prod-agents](bitshuriken-prod-agents/) | 백테스트·라이브 전략 실행기 | 5120 |

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
- [docs/adr/](docs/adr/) — 아키텍처 의사결정. 새 결정 발생 시 `docs/adr/NNN-제목.md` (Status/Context/Decision/Rationale/Consequences). 번호 순차 증가, 다음은 072. 코드 주석에 ADR 번호 박지 않는다.
- [docs/feedback/](docs/feedback/) — 유저 교정/피드백. **즉시 기록**: No/다른 방향 지시를 받으면 다음 작업 전에 먼저 `docs/feedback/NNN-제목.md` 작성 (Rule/Why/How to apply).
- [docs/specs/](docs/specs/) — 구현 플랜/관찰. `refactor-observations.md`에 오픈 버그(취소 레이스·trigger dead path 등) 기록.
- [docs/trading/](docs/trading/) — 트레이딩 지식 (시스템 리포트와 분리). `journal.md` 거래일지(런당 1항목, 최신 위), `lessons.md` 실증된 교훈(불변 번호, 반증 시 취소선). **전략 런 종료마다 두 파일 갱신**; 세션 원시 리포트는 여전히 docs/test-reports/.

## 공통 작업 규칙
- 요청한 범위만. 미리 구현 금지 (docs/feedback/001). 검증 안 된 코어 위에 큰 기능 미리 쌓지 않기 (docs/feedback/019).
- 정책 결정(마진모드/마크/청산/펀딩/보험기금/레이트리밋 등)은 유저 확정 후 (docs/feedback/016).
- 정책·상수성 설정은 .env 아니라 코드/DB (docs/feedback/020). 런타임 조회 가능한 목록은 하드코딩 금지 (docs/feedback/021).
- 주석은 핵심만 짧게, self-contained (docs/feedback/009).

## How to run (전체 스택)
**정본은 `./scripts/exchange.sh`** — 시작/정지/초기화가 각 단계를 기능 검증(HTTP 응답·pg_isready·토픽 파티션 수·엔진 인스턴스 수)할 때까지 끝나지 않고, 성공(exit 0)이면 실제로 떠 있음이 보장된다.
```bash
./scripts/exchange.sh start    # 인프라→토픽→BE(빌드+dist 실행)→매칭엔진→FE (검증 포함, 중복/잔재 자동 정리)
./scripts/exchange.sh stop     # 전 프로세스 종료 + 20s 리스폰 감시 (docker 인프라는 유지)
./scripts/exchange.sh reset    # stop → docker 볼륨 초기화 → 토픽 재생성 → migrate deploy + seed → 검증
./scripts/exchange.sh status   # 컴포넌트/포트/엔진/토픽/DB 상태
```
내장된 함정 방어 (2026-07-13 실측 사고들): ① Kafka 준비 전 앱 접속 시 토픽이 1-파티션으로 auto-create돼 lane 매핑 파괴 → 토픽은 앱보다 먼저 + 파티션 수 검증 + 자가치유. ② macOS venv python은 ps에 프레임워크 경로로 표시돼 pgrep 오탐 → 엔진은 마커 argv로 식별. ③ 죽은 세션의 감시 루프·고아 프로세스가 스택을 중복 기동 → start가 시작 전 전부 정리하고 기동 후 고아 dist를 탐지. ④ 포트 체크는 zsh `/dev/tcp`가 아닌 curl (zsh에선 항상 실패라 오탐). ⑤ BE는 `--watch` 금지, 빌드 후 dist 실행 (2026-07-14 사고: 소스 저장 → 라이브 무통보 재기동 → 정산 유실·레인 무반응. docs/specs/refactor-observations #21/#22). BE 코드 반영은 start 재실행으로.
`up.sh`/`down.sh`는 exchange.sh의 하위 구성요소로 남아 있으나 직접 쓰면 위 보장이 없다.
최초 1회(fresh clone): 루트 README의 서비스별 의존성 설치 후 `./scripts/exchange.sh reset`.
Windows는 WSL2 + Docker Desktop WSL integration을 사용한다. 개별 서비스 실행/컨벤션은 각 디렉터리의 CLAUDE.md 참조.
