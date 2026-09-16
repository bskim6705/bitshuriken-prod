# bitshuriken-prod-mcp

prod API 레퍼런스(spot/futures/portal)를 AI 클라이언트에 노출하는 읽기 전용 MCP 서버.
(시스템 개요·계약은 상위 `../CLAUDE.md`.)

## 원칙
- **읽기 전용**: 인증·주문·상태 변경 없음. `/docs-json` 조회만 (ADR-074).
- **스펙이 단일 소스**: 엔드포인트/가이드를 여기에 복제하지 않는다. 문서 수정은 BE의
  `libs/shared/src/docs/api-description.ts`와 컨트롤러 데코레이터에서 (ADR-046).
- **코어 스택 밖**: exchange.sh가 기동하지 않는 로컬 개발자 도구. 앱이 없으면 graceful 실패.

## Structure
- `src/openapi.ts` — `/docs-json` fetch + 캐시, `$ref` 해석, 엔드포인트/가이드 렌더·검색.
- `src/index.ts` — MCP 서버(stdio) + 도구 6종 등록.

## Run
```bash
npm install && npm run build   # dist/index.js
npm start                      # stdio — 클라이언트가 직접 spawn하므로 수동 실행은 보통 불필요
```
BE 주소는 `BITSHURIKEN_PROD_{SPOT,FUTURES,PORTAL}_URL` (기본 5101/5102/5103).
