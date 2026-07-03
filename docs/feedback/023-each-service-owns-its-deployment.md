# 023. 각 서비스는 자기 배포 정의를 소유한다 — infra compose에 보조 서비스를 욱여넣지 않는다

> **[bitshuriken-prod fork note, 2026-07-03]** 예시로 등장하는 bots/agents/mcp 레포는 이 포크에 포함되지 않는다. 원칙(infra compose는 코어 스택만, 보조 서비스는 자기 배포 정의 소유)은 그대로 유효하다.

## Rule
infra의 `docker-compose.prod.yml`은 **코어 거래소 스택**(be/fe/match + postgres/kafka/nginx)만 정의한다.
bots·agents·mcp 같은 **별개 서비스의 compose 서비스 블록을 infra에 추가하지 않는다.** 각 서비스는 자기 레포에
자기 배포 정의(Dockerfile + 자기 `docker-compose.yml`)를 갖고, 거래소에는 정의된 경계로 붙는다 —
같은 호스트면 infra 네트워크를 `external: true`로 부착, 원격이면 공개 API 클라이언트로.

## Why
- 서비스 경계는 코드뿐 아니라 **배포에서도** 지켜져야 한다. bots를 다른 머신/다른 시점에 독립 배포할 수 있어야
  하는데, infra compose에 박으면 코어 스택과 생명주기가 묶인다.
- infra는 "코어 제품 배포"라는 단일 책임을 가진다. 보조 서비스를 섞으면 책임이 흐려지고, 한 서비스 변경이
  코어 배포 파일을 건드리게 된다.
- 거대한 설명 주석·누수된 설정이 infra compose에 쌓이는 것 자체가 "여기 있을 게 아니다"라는 신호다.

## How to apply
- 보조 서비스는 자기 레포의 `docker-compose.yml`로 배포한다. 내부 DNS가 필요하면 infra 네트워크를
  `external: true`로 부착(`name: bitshuriken_internal`)하고, 아니면 공개 API로 붙는다.
- infra compose는 코어 스택만. 새 서비스를 추가하기 전에 "이게 코어 제품인가, 보조 서비스인가?"를 묻는다.
- 일반화(021·022 포함): 코드·설정·배포 어디서든 한 서비스의 것은 그 서비스에 둔다. infra는 오케스트레이션만.
