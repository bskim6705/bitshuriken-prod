# ADR-071: 서비스 저장소를 단일 Git 모노레포로 통합

## Status
Accepted (2026-08-22)

## Context
거래소 코어, 매칭엔진, 프론트엔드, 인프라, 미러 봇, 전략 실행기가 로컬의 독립 Git
저장소로 나뉘어 있고 어느 저장소에도 원격이 설정되어 있지 않았다. 다른 고성능 머신에서 전략
테스트를 재현하려면 여러 저장소와 현재 미커밋 작업을 따로 전달해야 하며, 서비스 간 계약 변경을
하나의 버전으로 고정할 수도 없었다.

## Decision

- `bitshuriken-prod`를 단일 Git 저장소로 삼고 `be`, `fe`, `match`, `infra`, `bots`, `agents`를
  현재 디렉터리 이름 그대로 추적한다.
- 각 서비스의 기존 커밋 이력은 모노레포 이력에 연결한다.
- 서비스별 `package.json`, Python 가상환경, 빌드 및 배포 단위는 유지한다. Nx/Turborepo나 루트
  패키지 workspace는 도입하지 않는다.
- `.env`, API 키, 로컬 DB/Kafka 볼륨, 로그, `node_modules`, Python 가상환경, 전략 실행 데이터와
  백업은 버전 관리하지 않는다.
- Windows 실행의 기준 환경은 WSL2와 Docker Desktop WSL integration이다.

## Rationale
단일 clone과 단일 commit으로 연결부를 재현할 수 있고, 현재 서비스 경계를 재설계하지 않아도
다른 머신으로 안전하게 옮길 수 있다. 패키지 workspace 도입은 경로와 빌드 계약을 바꾸므로 이번
저장소 통합 범위에는 필요하지 않다.

## Consequences

- 서비스 간 변경을 한 커밋과 한 브랜치에서 함께 검토하고 되돌릴 수 있다.
- clone 크기는 커지지만 런타임 산출물과 전략 데이터는 포함되지 않는다.
- 서비스별 독립 저장소를 전제로 한 문서와 자동화는 모노레포 상대 경로를 기준으로 유지해야 한다.
- 네이티브 PowerShell/CMD 실행은 지원하지 않으며 Windows에서는 WSL2가 필요하다.
