# ADR-065: 프로덕션 포크 — spot/futures 코어만 남긴 bitshuriken-prod

## Status
Accepted (2026-07-03)

## Context
bitshuriken v2는 spot/futures/portal 코어 위에 options(ADR-053~058), dex(ADR-051~052),
bots(ADR-037), agents(ADR-050·059), mcp(ADR-048)가 얹힌 상태였다. options/dex는 gated-off,
agents/bots는 로컬 도구, 코어 외 표면이 스키마·공유 라이브러리·배포 정의에 스며들어
"spot과 futures의 완벽한 동작"이라는 프로덕션 목표와 코드베이스의 실제 표면이 어긋났다.
feedback-019(검증 안 된 코어 위에 큰 기능을 미리 쌓지 않기)의 교훈이 누적된 상태.

## Decision
1. **시맨틱 포크.** `bitshuriken-v2`(구 워크스페이스 전체)를 `bitshuriken/bitshuriken-v2/`로
   아카이브(무변경 보존)하고, 정제된 프로덕션 프로젝트 **bitshuriken-prod**를
   `bitshuriken/bitshuriken-prod/`에 신설한다.
2. **범위.** 유지: be(spot/futures/portal), fe, match, infra + 정제된 docs.
   제외: options, dex, bots, agents, mcp — 코드·스키마·배포·설정·docs 전 표면에서 제거.
   서브계정(ADR-049)은 API 트레이딩 인프라로 유지.
3. **git fresh start.** 각 서브레포(`bitshuriken-prod-{be,fe,match,infra}`)와 우산 레포를
   새 git 히스토리(브랜치 `main` 통일)로 시작한다. 우산 레포가 docs/scripts/dev compose를
   버전 관리한다(구 워크스페이스에서 docs는 비버전 관리였음).
4. **프로드 전체 초기화.** 기존 프로드(bitshuriken.com, 2026-06-19 라이브)는 데이터까지
   싹 밀고 이 포크로 재배포한다. 따라서 Prisma 마이그레이션 히스토리도 리셋 —
   정제된 스키마(MarketType=SPOT|FUTURES, SettlementKind에서 OPTION_* 제거,
   BalanceSnapshot에서 optionsUsdt/dexUsdt 제거, options/dex 모델 전부 제거)로
   단일 `init` 마이그레이션을 새로 만든다.
5. **네이밍.** 레포/패키지/이미지(`ghcr.io/bskim6705/bitshuriken-prod-*`)/compose 프로젝트만
   `bitshuriken-prod`로 변경. 도메인(bitshuriken.com)·브랜딩(Bitshuriken)·DB명·TOTP issuer·
   쿠키/localStorage 키는 유지.

## Provenance (포크 시점 구 레포 상태)
| repo | branch | HEAD | dirty files |
| --- | --- | --- | --- |
| bitshuriken-v2-be | master | `da20b10` | 16 (uncommitted WIP 포함해 포크) |
| bitshuriken-v2-fe | main | `d6bb64b` | 83 |
| bitshuriken-v2-match | master | `c403801` | 11 |
| bitshuriken-v2-infra | main | `aaadf84` | 5 |

포크 소스는 **working tree**(미커밋 수정 포함 — 원했던 수정들). 아카이브가 그 바이트를 보존한다.

## Rationale
- 프로덕션 목표가 spot/futures 완성도이므로, 미검증 표면을 유지·리베이스하는 비용이
  제거 비용보다 크다. 필요해지면 아카이브에서 설계(ADR)와 코드를 다시 가져올 수 있다.
- 프로드 데이터가 초기화되므로 스키마·마이그레이션·enum을 무부채 상태로 정리할 수 있는
  유일한 시점이다(가동 후에는 Postgres enum 값 제거가 고통스럽다).

## Consequences
- ADR 번호는 구 체계를 승계(결번: 050~059의 드롭분, 055는 원래 결번). 새 ADR은 066부터.
- 드롭된 기능의 ADR 9개(050,051,052,053,054,056,057,058,059)는 이관하지 않음 —
  아카이브 `bitshuriken-v2/docs/adr/`에서 열람.
- 새 프로드는 미러링 봇이 없으므로 오더북 유동성이 비어 있다. 유동성 공급은
  아카이브의 bots를 외부 클라이언트로 붙이거나 다른 메이커를 만드는 후속 작업.
- 알려진 미해결 이슈는 포크로 승계된다: 주문 취소 레이스, trigger dead path
  (docs/specs/refactor-observations.md), futures 청산 보험기금 원장 누락,
  ADR-064 런타임 e2e 미검증, ADR-060 rate-limit 미구현.
