# Feedback-012: UI/UX 텍스트는 전부 영어로 통일

## Rule
프론트엔드 UI/UX에 표시되는 모든 텍스트(버튼, 라벨, 헤더, placeholder, hint, 안내 문구, 에러 메시지 등)는 **영어로만 작성**한다. 한영 혼용 금지. 내부 코드 주석, `docs/adr/`, `docs/feedback/`, 커밋 메시지, README는 한글 허용.

## Why
- 플랫폼은 도메인 공개 배포 예정 → 외부 유저가 볼 때 한영 믹스는 산만하고 프로페셔널하지 않음
- 영어 통일은 Binance/OKX/Bybit 등 표준 거래소 컨벤션과 일치
- Agent/LLM 독해도 영어가 유리
- 내부 전용 문서(ADR, 피드백)는 팀이 빠르게 쓰기 위한 도구 → 한글 유지

## How to apply
- 컴포넌트 JSX 내 텍스트 노드, `placeholder`, `aria-label`, `title`, 버튼 라벨, 헤더 문구 → 영어
- 외부 레퍼런스 노출 금지: `ADR-013` 같은 내부 문서 번호를 랜딩/UI에 박지 않는다. 필요시 일반 독자가 읽을 수 있는 표현으로 풀어쓴다 (예: "Lane-based matching architecture")
- 설명·hint는 간결한 영어로 (예: "Balances reflect the settlement log", "Rate limits apply per API key")
- 코드 주석·JSDoc은 한글 가능
- 에러 메시지·토스트·dialog 도 전부 영어
