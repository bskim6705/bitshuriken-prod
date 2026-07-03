# ADR-001: 단일 DB + MarketType enum으로 마켓 구분

## Status
Accepted

## Context
spot, futures, options 등 여러 마켓을 지원해야 한다. DB를 마켓별로 분리할지, 하나로 통합할지 결정이 필요하다.

## Decision
DB 하나 + 테이블에 `MarketType` enum(SPOT, FUTURES, OPTIONS 등)으로 구분한다.

## Rationale
- **유저별 샤딩과의 호환**: 마켓별 DB 분리 + 유저별 샤딩을 동시에 하면 조합이 폭발한다. 단일 DB면 한 유저의 모든 마켓 데이터가 같은 샤드에 위치하여 로컬 쿼리로 처리 가능.
- **Cross-margin / Portfolio margin 확장**: 자산 간 조회가 빈번한데, DB가 분리되면 서비스 간 통신이 필요해져 복잡도가 급증한다.
- **운영 부담**: 초기 단계에서 여러 DB를 관리하는 것은 오버엔지니어링.

## Consequences
- Multi-asset, portfolio margin 등 확장 시 통합 레이어를 자연스럽게 추가할 수 있다.
- 마켓별 독립 배포/장애 격리는 불가하지만, 현재 규모에서는 불필요하다.
