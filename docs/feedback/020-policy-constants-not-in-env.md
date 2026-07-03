# 020. 정책/상수성 설정은 .env가 아니라 코드 config 또는 DB에

## Rule
Rate-limit 한도처럼 **배포마다 바뀌지 않는 정책/상수성 값**은 `.env`에 흩뿌리지 않는다.
rate-limit 모듈 내 코드 config(per-market 기본값) 또는 DB에 단일 출처로 둔다.
`.env`에는 **진짜 환경/배포별 값**만 남긴다: 시크릿(`*_TOKEN`), on/off 토글(`*_ENABLED`), 토폴로지(`TRUST_PROXY_HOPS`).

## Why
- weight 한도(spot 6000 / futures 2400)·orders·raw 같은 수치는 Binance 미러 상수라 환경에 따라 변하지 않는다.
  환경 변수의 본래 용도(배포별로 달라지는 값)와 맞지 않는다.
- 앱별로 값이 다른데(spot vs futures) 단일 공유 `.env`로는 한 값밖에 못 줘서 "프로세스 env 오버라이드 필요" 같은
  군더더기가 생긴다 — 이는 값이 `.env`에 있을 자리가 아니라는 신호다.
- 코드/DB에 두면 앱·마켓별 선택이 자연스럽고, 단일 출처라 drift가 없다. DB면 admin 런타임 튜닝까지 가능.

## How to apply
- 수치 한도는 rate-limit 모듈의 per-market 기본 config(코드) 또는 DB 테이블(+ 인메모리 캐시)로 옮기고,
  각 앱이 자기 market/app 키로 선택한다.
- `.env`에는 `RATE_LIMIT_ENABLED`, `RATE_LIMIT_INTERNAL_TOKEN`, `RATE_LIMIT_TRUST_PROXY_HOPS`만 남긴다.
- 더 넓게: 새 설정을 추가할 때 "이 값이 배포마다 다른가?"를 먼저 묻는다. 아니면 `.env`가 아니라 코드/DB다.
