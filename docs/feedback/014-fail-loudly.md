# Feedback-014: 조용히 default 쓰거나 에러 삼키지 않는다

## Rule
필수 설정값이 없으면 즉시 throw. catch에서 빈 블록 금지. 에러를 먹을 거면 이유를 주석으로 남기고 최소한 `console.error`로 기록.

## Why
- `process.env.X ?? "default"` 같은 fallback은 prod에서 "값이 왜 이래?" 디버깅 시간을 부름. 잘못된 URL/포트로 한참 요청 가다가 늦게 발견
- 빈 catch는 버그를 감춘다. 처음엔 편해 보여도 나중에 "로그 아무것도 안 찍히는데 왜 안됨?" 상황
- 설정 누락은 startup에서 실패하는 게 가장 싸다. 실행 중 우회 경로로 가다가 깨지면 추적비가 배
- BE는 이미 `if (!secret) throw new Error('JWT_SECRET is required')` 패턴. FE도 같은 결로

## How to apply
- 필수 env: 모듈 로드/생성자 시점에 throw. default 금지
  - `const url = process.env.NEXT_PUBLIC_API_URL; if (!url) throw new Error('NEXT_PUBLIC_API_URL is required');`
- 선택 env: default 허용. 다만 "왜 선택인지" 주석 또는 자명하게
- catch 블록: 빈 body 금지. 최소 `console.error(..., err)`. 완전히 무시할 거면 그 이유를 주석으로
- 사용자 흐름에 영향 없는 복구 가능 에러(예: JSON parse 실패로 undefined 바디 허용)도 개발자에게는 보여야 함: 로그는 남기고 로직은 진행
- null-coalesce `??`·or-fallback `||`을 env/인자 값에 쓰는 순간 멈추고 "이건 진짜 optional인가?" 재확인
