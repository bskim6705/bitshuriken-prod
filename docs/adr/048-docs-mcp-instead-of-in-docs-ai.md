# ADR-048: 문서 내 AI 채팅 제거 + 읽기 전용 문서 MCP 서버

> **[bitshuriken-prod fork note, 2026-07-03]** `bitshuriken-v2-mcp` 서버는 이 포크에 포함되지 않는다(아카이브에 보존). §"Ask AI 제거"와 API 문서를 백엔드 description으로 이관한 결정(ADR-046의 배경)은 이 포크에서도 유효하다.

## Status
Accepted (2026-06-15)

## Context
Scalar API 레퍼런스는 사이드바 "Ask AI"와 operation별 "Ask AI Agent" 채팅을 기본 노출한다. 이 인-브라우저 채팅 대신, 사용자가 자기 AI 도구(Claude 등)에서 API를 이해·질의할 수 있는 표준 인터페이스(MCP)를 원했다.

## Decision

### 1. 문서 내 AI 채팅 비활성화
FE Scalar 설정에서 각 소스에 `agent: { disabled: true }`를 지정해 "Ask AI"/"Ask AI Agent"를 끈다(공식 옵션). 사이드바 버튼 CSS 숨김은 백업으로 유지.

### 2. 읽기 전용 문서 MCP 서버 (`bitshuriken-v2-mcp`)
새 standalone 패키지(Node/TS, `@modelcontextprotocol/sdk`, **stdio** 트랜스포트). 각 백엔드의 `/docs-json`(ADR-046로 self-contained)을 로드해 도구로 노출:
- `list_products`, `list_endpoints`(product/keyword 필터), `get_endpoint`(파라미터·바디·응답 상세), `get_guide`(Overview/Auth/WS/User data/Errors 마크다운), `search`, `refresh`
- base URL은 env(`BITSHURIKEN_{SPOT,FUTURES,PORTAL}_URL`, 기본 localhost:5101/5102/5103)
- **읽기 전용** — 인증·주문 없음. 스펙이 진실 소스이므로 MCP는 별도 지식 복제 없이 항상 최신.

## 범위 밖
- 공개 시장 데이터 실시간 호출, 인증/주문 실행 MCP — 의도적으로 제외(읽기 전용 선택). 추후 필요 시 확장.
- MCP를 BE 앱에 통합하지 않고 별도 패키지로 유지(서비스 분리 패턴, ADR-046의 self-contained 스펙 재사용).

## Consequences
- 문서 페이지는 AI 채팅 없이 단순해지고, AI 활용은 사용자 자신의 MCP 클라이언트로 이동(제어·프라이버시 향상).
- MCP는 `/docs-json`에 의존 → 조회 도구는 백엔드 기동 필요(없으면 도구가 "backend running?" 안내로 graceful 실패).
- 새 패키지 = 별도 `npm install`/빌드. CI/배포에 포함하려면 별도 설정 필요(현재 로컬 개발자 도구).

## 관계
- [ADR-046](046-api-docs-source-in-backend-description.md): self-contained `/docs-json` — MCP가 이를 단일 소스로 사용
- [feedback-018](../feedback/018-api-docs-unified-per-product.md): 제품별 통합 문서
