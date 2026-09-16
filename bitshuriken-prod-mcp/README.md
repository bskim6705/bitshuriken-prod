# bitshuriken-prod-mcp

Read-only [MCP](https://modelcontextprotocol.io) server for the Bitshuriken
(production) API reference. It exposes the spot / futures / portal OpenAPI
documents — endpoints, schemas, and the auth / rate-limit / WebSocket / error
guides — as tools, so an AI assistant can answer questions about the API.

It is **read-only** — no authentication, no order placement. It only reads each
app's `/docs-json`, so the spec is always the single source of truth (ADR-074,
포크 전 결정은 ADR-048).

## Tools

| Tool | Purpose |
| --- | --- |
| `list_products` | spot/futures/portal with base URLs + endpoint counts |
| `list_endpoints` | `METHOD /path — summary`, optional product/keyword filter |
| `get_endpoint` | full detail (params, request body, responses) for one endpoint |
| `get_guide` | narrative guide markdown (Overview/Authentication/Rate limits/Error codes/WebSocket/User data/Subaccounts), optional section |
| `search` | keyword search across endpoints + guides |
| `refresh` | drop cached specs (refetch on next call) |

## Setup

```bash
cd bitshuriken-prod-mcp
npm install
npm run build
```

The server reads specs over HTTP, so the BE apps must be running
(`./scripts/exchange.sh start`). Base URLs default to localhost and can be
overridden:

| Env | Default |
| --- | --- |
| `BITSHURIKEN_PROD_SPOT_URL` | `http://localhost:5101` |
| `BITSHURIKEN_PROD_FUTURES_URL` | `http://localhost:5102` |
| `BITSHURIKEN_PROD_PORTAL_URL` | `http://localhost:5103` |

앱이 내려가 있으면 각 도구는 "is the stack running?" 안내로 graceful 실패한다(크래시 없음).

## Connect a client

**Claude Code:** 저장소 루트의 [`.mcp.json`](../.mcp.json)에 `bitshuriken-prod-docs`로
이미 등록돼 있다 — 이 저장소에서 Claude Code를 열면 잡히고, 최초 1회 승인 프롬프트가 뜬다.
경로는 저장소 루트 기준 상대경로라 루트에서 실행할 때 동작한다(서브디렉터리에서 띄워 경로가 안 맞으면
`args`를 절대경로로 바꾼다). 수동 등록이 필요하면:

```bash
claude mcp add bitshuriken-prod-docs -- node /absolute/path/to/bitshuriken-prod-mcp/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "bitshuriken-prod-docs": {
      "command": "node",
      "args": ["/absolute/path/to/bitshuriken-prod-mcp/dist/index.js"],
      "env": {
        "BITSHURIKEN_PROD_SPOT_URL": "http://localhost:5101",
        "BITSHURIKEN_PROD_FUTURES_URL": "http://localhost:5102",
        "BITSHURIKEN_PROD_PORTAL_URL": "http://localhost:5103"
      }
    }
  }
}
```

Transport is stdio. 서버 이름·env 프리픽스가 아카이브의 `bitshuriken-v2-mcp`(`bitshuriken-docs`,
`BITSHURIKEN_*`)와 분리돼 있어 두 서버를 동시에 등록해도 충돌하지 않는다.
