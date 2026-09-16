# 074. prod 전용 API 문서 MCP 서버

## Status
Accepted (2026-09-16)

## Context
포크 시 `bitshuriken-v2-mcp`(ADR-048)는 prod에서 제외되고 아카이브에만 남았다(ADR-065). 그러나 그 서버가 의존하던 전제는 prod에서 그대로 유효하다 — spot/futures/portal 3앱이 self-contained OpenAPI를 `/docs-json`으로 서빙하고(ADR-046), 문서 본문(Overview/Authentication/Rate limits/Error codes/WebSocket/User data/Subaccounts)은 `libs/shared/src/docs/api-description.ts`에 있다. AI 클라이언트에서 prod API를 질의하려면 v2 아카이브 서버를 가리키거나(포크 전 스펙 — options/dex 포함, 포트·문서 동일 보장 없음) 매번 수동 fetch해야 했다.

## Decision
- `bitshuriken-prod-mcp/` 신설 — 읽기 전용 MCP 서버(Node/TS, `@modelcontextprotocol/sdk`, **stdio**). 도구는 v2와 동일한 6종: `list_products`, `list_endpoints`, `get_endpoint`, `get_guide`, `search`, `refresh`.
- **아카이브와 네임스페이스 분리**: 서버명 `bitshuriken-prod-docs`, env `BITSHURIKEN_PROD_{SPOT,FUTURES,PORTAL}_URL`(기본 5101/5102/5103). 두 서버를 한 클라이언트에 동시 등록해도 충돌하지 않는다.
- 저장소 루트 `.mcp.json`에 프로젝트 스코프로 등록(상대 경로 `bitshuriken-prod-mcp/dist/index.js`). `${CLAUDE_PROJECT_DIR}` 확장은 지원되지 않아 쓰지 않는다.
- **읽기 전용 유지** — 인증·주문·상태 변경 없음. 스펙이 단일 소스이므로 별도 지식 복제 없음.
- 코어 스택 밖의 로컬 개발자 도구 — `exchange.sh`가 기동/검증하지 않는다(feedback-023: 서비스는 자기 배포를 소유). BE가 내려가 있으면 각 도구는 "is the stack running?" 안내로 graceful 실패.

## Rationale
- prod 문서는 포크 이후 독자적으로 갈라졌다(options/dex 제거, rate limits 섹션 추가, 수수료 티어 등). prod 스펙을 읽는 서버가 prod 저장소 안에 있어야 최신성이 자동 보장된다.
- 아카이브(수정 금지)를 건드리지 않고 포팅하는 편이, v2 서버를 prod에 겨누도록 재설정하는 것보다 안전하다.
- 거래 실행·시장 데이터 MCP는 여전히 범위 밖(ADR-048과 동일한 선택). 필요해지면 별도 ADR — 읽기 전용 경계가 "봇도 유저다"(feedback-025)와 충돌하지 않게 유지한다.

## Consequences
- 별도 `npm install` + `npm run build` 필요(루트 README 최초 1회 목록에 추가). dist는 Git 미포함.
- 프로젝트 스코프 MCP 서버는 클라이언트에서 1회 승인이 필요하다(Claude Code: 최초 실행 시 승인 프롬프트).
- 조회 도구는 BE 기동에 의존 — 문서만 보려고 스택 전체를 띄워야 한다는 제약은 ADR-048과 동일하게 남는다.

## 관계
- [ADR-048](048-docs-mcp-instead-of-in-docs-ai.md): v2의 원 결정(문서 내 Ask AI 제거 + MCP). 이 ADR이 prod 부활분.
- [ADR-046](046-api-docs-source-in-backend-description.md): self-contained `/docs-json` — MCP의 단일 소스.
- [ADR-065](065-production-fork.md): 포크 시 mcp 제외 결정을 이 ADR이 뒤집는다(bots/agents와 같은 경로).
