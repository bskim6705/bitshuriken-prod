# Feedback-011: 랜딩/카피 톤은 "Bitninja 내부용 초대제 플랫폼" 방향

> **[bitshuriken-prod fork note, 2026-07-03]** 에이전트 프레임워크(`bitshuriken-v2-agents`)는 이 포크에 포함되지 않지만, "내부 팀 + 그들이 돌리는 에이전트(외부 API 클라이언트)를 위한 플랫폼"이라는 포지셔닝과 카피 톤 규칙은 그대로 유효하다.

## Rule
Bitshuriken은 **Bitninja**(내부 팀 + AI agent)를 위한 전략 테스팅 플랫폼이다. 공개 배포되지만 일반 사용자를 타깃하지 않으며, 외부 유저의 접근은 환영도 제한도 하지 않는다(단 언제든 정지 가능). 카피는 **차분하고 담백한 프로페셔널 톤**에 가벼운 드라이 위트를 섞는다. 광대짓(coffee supply, 존버/COPIUM 같은 밈 티커, "free ruin" 같은 자조) 금지.

## Why
- 플랫폼 용도는 진짜 운영되는 매칭엔진 위에서 전략/agent 테스팅 → 장난감처럼 보이면 신뢰도 없음
- 내부 팀·agent 대상이지만 도메인 공개 → 외부자는 구경꾼 포지션이 자연스럽고, 그에 맞는 거리감 있는 hospitality 필요
- 전문성 떨어지는 밈 농담은 플랫폼의 결(매칭엔진/정산/HMAC 인증 같은 실제 엔지니어링)과 충돌
- 가벼운 드라이 위트는 허용 — 너무 딱딱하면 내부 툴 특유의 성격이 안 묻어남

## How to apply
- **포지셔닝 문구**: "A trading terminal for the Bitninja collective." / "Strategy testing on a real matching engine, for our team and the agents they run." 식
- **외부자 대우**: "You didn't get an invite. We didn't send one. Accounts may be suspended at any time." — 정중하되 거리감 유지. 쫓아내지 않고, 환영도 안 함
- **티커/데이터**: 실제 티커(BTC, ETH, SOL, XRP, BNB, DOGE)만. COPIUM/존버/TENDIES/MOON 같은 밈 심볼 금지
- **유동성 설명**: "Closed-loop testnet liquidity. We mine on ETH testnet, sell into our internal market, fund user USDT balances. No withdrawals."
- **경고 문구**: 드라이하게. "Balances have no off-platform value." "Data is not backed up. Plan accordingly." "We publish no uptime SLA."
- **Testimonials/Leaderboard**: 넣으려면 내부 agent 로스터 형식으로(kitsune-α, hayabusa-v2 등). 가짜 @handle 인용문은 제거
- **금지**: coffee/printer/Post-it 같은 사무실 밈, "free ruin", "fastest 500 I've triggered" 계열 자조, 너무 직접적인 셀프디스
- **허용**: "We know who you are. You are here." 수준의 차분한 위트, 현실 인정("Futures is stubbed. Yes, we're aware."), 건조한 약관 유머
