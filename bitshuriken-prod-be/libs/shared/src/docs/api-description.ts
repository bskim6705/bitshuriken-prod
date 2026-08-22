import { renderErrorCodesMarkdown } from './error-codes-doc';
import { limitsForApp, RateLimitApp } from '../rate-limit/rate-limit.defaults';

// Per-product OpenAPI `info.description` (markdown). The Scalar reference renders
// these in the same sidebar/layout as the REST endpoints, so each product reads
// as one unified doc: overview -> auth -> WebSocket streams -> user data -> errors.
// WebSocket/user-data streams aren't REST operations, so they're documented here.

const F = '```';
const code = (lang: string, body: string) => `${F}${lang}\n${body}\n${F}`;

// ---- shared fragments ----

const responseEnvelope = `Every REST response is wrapped in a \`{ code, message, data }\` envelope: \`code\` 0 / \`message\` "ok" on success; a non-zero \`code\` + \`message\` + \`data: null\` on error. Numeric codes are stable and grouped by domain (see **Error codes**).

${code(
  'jsonc',
  `// success
{ "code": 0, "message": "ok", "data": { "...": "endpoint payload" } }
// error
{ "code": 30002, "message": "Insufficient balance", "data": null }`,
)}`;

const authSection = `## Authentication

Endpoints fall into three auth classes. The signature scheme matches Binance Spot, so existing SDKs work. \`Authorization: Bearer <jwt>\` is accepted for web flows; API-key issuance itself is JWT-only to prevent key escalation.

- **NONE** — public market data (e.g. recent trades, all market WebSocket streams). No credentials.
- **COOKIE (session)** — web UI. The \`bs_session\` cookie carries a session JWT; the user data WebSocket also accepts it (with an Origin check).
- **API-KEY-SIGNED (HMAC)** — bots/SDKs. \`X-API-Key\` header plus a per-request HMAC signature in the query string. \`USER_DATA\` endpoints require \`canRead\`; \`TRADE\` endpoints require \`canTrade\`.

### Signed request scheme

The signature is \`HMAC-SHA256(query_string + body, secret)\` as lowercase hex, passed as the \`signature\` query parameter. The server recomputes over the raw query string (excluding \`signature\`) plus the raw body and compares. Requests where \`|now - timestamp| > recvWindow\` (default 5000ms) are rejected.

${code(
  'http',
  `GET /spot/account/balances?timestamp=1718323200000&recvWindow=5000&signature=<hex>
X-API-Key: <public key>

# canonical string = raw query string (minus signature) + raw request body
# timestamp and recvWindow live in the query string, not in headers`,
)}`;

const errorSection = `## Error codes

Every error returns through the global envelope as \`{ code, message, data: null }\`. The numeric \`code\` is stable and grouped by domain; \`message\` is human-readable and may vary.

${renderErrorCodesMarkdown()}`;

const wsControl = `### Control protocol

Send a control frame to subscribe or unsubscribe. \`method\` is \`SUBSCRIBE\` or \`UNSUBSCRIBE\`, \`streams\` is the array of stream names, \`id\` echoes back. Unknown streams are reported in an \`error\` frame; valid ones still subscribe. Heartbeat: the server pings every 30s; a missed pong terminates the socket.

${code(
  'jsonc',
  `// client -> server
{ "method": "SUBSCRIBE", "streams": ["btcusdt@depth", "btcusdt@trade"], "id": 1 }
// ack (all valid)            // rejection (unknown streams)
{ "result": null, "id": 1 }   { "error": "invalid streams", "streams": ["foo@bar"], "id": 1 }`,
)}

Every data push is wrapped in a \`{ stream, data }\` envelope so one socket can multiplex many streams. kline intervals: \`1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1M\`.

${code('json', `{ "stream": "btcusdt@bookTicker", "data": { "...": "stream-specific named payload" } }`)}`;

const wsStreamTable = `### Streams

| Stream | Cadence | Notes |
| --- | --- | --- |
| \`<symbol>@depth\` | on book change | full top-50 snapshot (not a diff) |
| \`<symbol>@trade\` | 1 per fill | array; snapshot is the recent 50 |
| \`<symbol>@aggTrade\` | price/side change + 1s | \`isBuyerMaker\` true when taker is SELL |
| \`<symbol>@kline_<interval>\` | every 1s | \`isFinal\` true on bar close |
| \`<symbol>@bookTicker\` | on best change | best bid/ask |
| \`<symbol>@miniTicker\` | 1s (throttled) | only symbols with new trades |
| \`<symbol>@ticker\` | on trade | full 24h stats |
| \`!ticker@arr\` | every 1s | array of \`@ticker\` |
| \`!miniTicker@arr\` | every 1s | array of \`@miniTicker\` |`;

const wsPayloads = `${code(
  'jsonc',
  `// <symbol>@depth
{ "lastUpdateId": 184722,
  "bids": [["50000.00","0.42000000"],["49999.50","1.10000000"]],
  "asks": [["50001.00","0.35000000"],["50002.00","0.80000000"]] }`,
)}

${code(
  'jsonc',
  `// <symbol>@trade (array; recent 50 then 1 per fill)
[{ "id": "trd_9f3a", "symbol": "BTCUSDT", "price": "50000.00",
   "qty": "0.01000000", "side": "BUY", "ts": 1718323200000 }]`,
)}

${code(
  'jsonc',
  `// <symbol>@kline_<interval>
{ "openTime": 1718323200000, "closeTime": 1718323259999,
  "open": "50000.00", "high": "50120.00", "low": "49980.00",
  "close": "50090.00", "volume": "12.40000000", "isFinal": false }`,
)}

${code(
  'jsonc',
  `// <symbol>@bookTicker
{ "symbol": "BTCUSDT", "bidPrice": "50000.00", "bidQty": "0.42000000",
  "askPrice": "50001.00", "askQty": "0.35000000", "lastUpdateId": 184722 }`,
)}

${code(
  'jsonc',
  `// <symbol>@ticker (24h stats; @miniTicker is a lighter subset)
{ "symbol": "BTCUSDT", "marketType": "SPOT", "baseAsset": "BTC", "quoteAsset": "USDT",
  "pricePrecision": 2, "qtyPrecision": 8, "lastPrice": "50090.00", "open24h": "49800.00",
  "priceChange24h": "290.00", "priceChangePct24h": "0.58", "high24h": "50120.00",
  "low24h": "49700.00", "volume24h": "120.40000000", "quoteVolume24h": "6024500.00",
  "tradeCount24h": 8421 }`,
)}`;

// ---- spot ----

const spotWsSection = `## WebSocket market streams

Public, unauthenticated market data over \`/ws/market\`. After connecting, subscribe with the lowercase symbol (e.g. \`btcusdt@depth\`); the server replies, then pushes a one-time snapshot followed by live updates.

${wsControl}

${wsStreamTable}

${wsPayloads}`;

const spotUserData = `## User data stream

Authenticated per-user push of order and balance changes over \`/ws/user\`. There is no SUBSCRIBE step — events flow on connect. On every (re)connect, resync over REST (the stream has no replay or snapshot).

### listenKey lifecycle

A listenKey opens the stream for non-cookie clients (bots/SDKs), with a 60-minute sliding expiry. Auth is checked once at upgrade: the \`bs_session\` cookie JWT (+ Origin check), or \`?listenKey=<key>\` appended to the URL. On expiry/revocation the socket closes with code \`4401\`, preceded by a \`listenKeyExpired\` event so the client can re-issue and reconnect.

- \`POST /spot/user-data-stream\` — create a listenKey (60-min expiry)
- \`PUT /spot/user-data-stream?listenKey=\` — keepalive (extend 60 min)
- \`DELETE /spot/user-data-stream?listenKey=\` — revoke (closes the socket)

### Events

\`executionReport\` — order lifecycle. Per-fill fields (\`lastFilledQty\`, \`lastFilledPrice\`, \`commission\`, \`commissionAsset\`, \`tradeId\`) appear only on updates carrying a fill.

${code(
  'json',
  `{ "stream": "executionReport", "data": {
    "orderId": "ord_71c2", "orderListId": "lst_22a0", "symbol": "BTCUSDT",
    "side": "BUY", "type": "LIMIT", "timeInForce": "GTC", "price": "50000.00",
    "origQty": "0.10000000", "executedQty": "0.04000000", "cumulativeQuoteQty": "2000.00",
    "status": "PARTIALLY_FILLED", "lastFilledQty": "0.01000000", "lastFilledPrice": "50000.00",
    "commission": "0.00001000", "commissionAsset": "BTC", "tradeId": "trd_9f3a", "ts": 1718323200000 } }`,
)}

\`outboundAccountPosition\` — balances captured inside the write txn. \`listStatus\` — OCO / order-list state change.

${code(
  'json',
  `{ "stream": "outboundAccountPosition", "data": { "balances": [
    { "asset": "USDT", "free": "3000.00", "locked": "2000.00", "ts": 1718323200000 },
    { "asset": "BTC", "free": "0.04000000", "locked": "0.00000000", "ts": 1718323200000 } ] } }`,
)}`;

// ---- futures ----

const futuresWsSection = `## WebSocket market streams

Public market data over \`/ws/fmarket\`. Mirrors every spot stream (\`@depth\`, \`@trade\`, \`@aggTrade\`, \`@kline_<interval>\`, \`@bookTicker\`, \`@miniTicker\`, \`@ticker\`, \`!ticker@arr\`, \`!miniTicker@arr\`) with identical payloads, plus the futures-only mark price streams below.

${wsControl}

${wsStreamTable}

### Mark price (futures only)

| Stream | Cadence | Notes |
| --- | --- | --- |
| \`<symbol>@markPrice\` | every 1s | mark + index (index = EMA of spot last), funding rate, next funding |
| \`!markPrice@arr\` | every 1s | all symbols; omits \`lastFundingRate\` |

${code(
  'json',
  `{ "symbol": "BTCUSDT", "markPrice": "50085.00", "indexPrice": "50080.00",
  "lastFundingRate": "0.00010000", "nextFundingTime": 1718352000000 }`,
)}

${wsPayloads}`;

const futuresUserData = `## User data stream

Authenticated per-user push over \`/ws/fuser\`. \`outboundAccountPosition\` and \`listenKeyExpired\` match the spot shapes; the listenKey endpoints live under \`/futures/account/user-data-stream\`. Futures adds the enriched \`executionReport\`, \`positionUpdate\`, and the \`MARGIN_CALL\` pre-warning.

### Events

\`executionReport\` — adds \`reduceOnly\` and \`realizedPnl\`; per-fill detail fields are \`null\` on no-fill updates.

${code(
  'json',
  `{ "stream": "executionReport", "data": {
    "orderId": "ford_5b1a", "symbol": "BTCUSDT", "side": "SELL", "type": "MARKET",
    "price": null, "origQty": "0.20000000", "executedQty": "0.20000000",
    "cumulativeQuoteQty": "10018.00", "status": "FILLED", "reduceOnly": true,
    "lastFilledQty": "0.20000000", "lastFilledPrice": "50090.00",
    "commission": "4.00720000", "commissionAsset": "USDT", "tradeId": "ftrd_3c8e",
    "realizedPnl": "18.00000000", "ts": 1718323200000 } }`,
)}

\`positionUpdate\` — \`qty\` is signed (+long / -short). \`markPrice\`/\`unrealizedPnl\` are \`null\` until mark forms. \`liquidationPrice\` is computed for ISOLATED only; CROSS sends \`null\` (read it from \`GET /futures/account/positions\`).

${code(
  'json',
  `{ "stream": "positionUpdate", "data": { "positions": [
    { "symbol": "BTCUSDT", "qty": "0.50000000", "entryPrice": "49500.00",
      "isolatedMargin": "2475.00", "leverage": 10, "marginMode": "ISOLATED",
      "status": "OPEN", "markPrice": "50085.00", "unrealizedPnl": "292.50000000",
      "liquidationPrice": "45100.00", "ts": 1718323200000 } ] } }`,
)}

\`MARGIN_CALL\` — notification-only liquidation pre-warning, fired once when \`marginRatio\` enters the warn band (default \`0.8\`). CROSS sends one account-level ratio.

${code(
  'json',
  `{ "stream": "MARGIN_CALL", "data": { "symbol": "BTCUSDT", "marginMode": "ISOLATED",
  "marginRatio": "0.82000000", "markPrice": "45800.00", "ts": 1718323200000 } }`,
)}`;

const subaccountSection = `## Subaccounts

Subaccounts are isolated trading accounts under a master account, built for automated agents: a subaccount has **no login** — the master creates it and issues API keys for it, and the agent authenticates with those keys only. Each subaccount has its own wallets, orders, and positions (fully isolated), and inherits the master's fee rates at creation.

Management endpoints are **session-only** (the master's cookie/Bearer JWT, not an API key) to prevent privilege escalation.

| Action | Endpoint |
| --- | --- |
| Create subaccount | \`POST /subaccounts\` |
| List subaccounts | \`GET /subaccounts\` |
| Subaccount balances | \`GET /subaccounts/{id}/balances\` |
| Issue subaccount API key | \`POST /subaccounts/{id}/api-keys\` |
| List / revoke keys | \`GET\` / \`DELETE /subaccounts/{id}/api-keys[/{keyId}]\` |
| Move funds between accounts | \`POST /subaccounts/transfers\` |

### Funding agents

\`POST /subaccounts/transfers\` moves a balance between two accounts under the same master (master↔sub, sub↔sub) within one market (\`SPOT\` default). To move funds across markets, use the per-account \`POST /account/transfers\` (spot↔futures) with that account's key. External deposit/withdrawal stays master-only; subaccounts are funded by internal transfer.

${code(
  'json',
  `// fund a subaccount's spot wallet from the master
{ "fromAccountId": "<master-id>", "toAccountId": "<subaccount-id>",
  "assetSymbol": "USDT", "market": "SPOT", "qty": "1000.00000000" }`,
)}`;

// ---- rate limits ----

const endpointWeightTable = `### Endpoint weight

Each endpoint costs a request weight; endpoints not listed cost **1**. Order placement (\`POST .../trading/orders\`) additionally increments the per-account ORDERS counters.

| Endpoint | Weight |
| --- | --- |
| \`GET …/market/exchange-info\` | 20 |
| \`GET …/market/tickers\` | 80 |
| \`GET …/market/depth\` | 5 |
| \`GET …/market/klines\` | 2 |
| everything else | 1 |`;

// Numbers come from the code-side per-app config (rate-limit.defaults), so these docs
// can't drift from the live limiter. (Internal first-party exemption is deliberately undocumented.)
const rateLimitSection = (app: RateLimitApp, withWeights = false) => {
  const l = limitsForApp(app);
  return `## Rate limits

Binance-style **weight-based** limiting: request weight is counted per IP, order placement per account. Every response carries the running tallies so clients can self-throttle:

- \`X-MBX-USED-WEIGHT-1M\` — request weight used in the current 1-minute window
- \`X-MBX-ORDER-COUNT-10S\` / \`X-MBX-ORDER-COUNT-1D\` — orders placed in the rolling 10s / 1d windows (on order endpoints)

Exceeding a limit returns **HTTP 429** with a \`Retry-After\` header (seconds) plus the used-weight headers; the envelope \`code\` is \`10007\` (request weight / raw requests) or \`10008\` (orders). Back off until \`Retry-After\` elapses, then retry. The live limits are also published in \`exchange-info\` under \`rateLimits\`. Limits may be relaxed or disabled in some environments — honor \`Retry-After\` and the used-weight headers whenever they are present.

### Limits

| Type | Window | Limit |
| --- | --- | --- |
| REQUEST_WEIGHT | 1 min | ${l.weightPerMin} |
| ORDERS | 10 s | ${l.ordersPer10s} |
| ORDERS | 1 day | ${l.ordersPer1d} |
| RAW_REQUESTS | 5 min | ${l.rawPer5Min} |${withWeights ? `\n\n${endpointWeightTable}` : ''}`;
};

// ---- exported per-product descriptions ----

export const SPOT_API_DESCRIPTION = [
  `## Overview\n\nSpot trading REST + WebSocket API. Base URL \`http://localhost:5101\`.\n\n${responseEnvelope}`,
  authSection,
  rateLimitSection('spot', true),
  errorSection,
  spotWsSection,
  spotUserData,
].join('\n\n');

export const FUTURES_API_DESCRIPTION = [
  `## Overview\n\nUSDⓈ-M futures REST + WebSocket API. Base URL \`http://localhost:5102\`. Adds mark/index price, positions (signed qty), leverage, isolated/cross margin, funding, and liquidation on top of the spot surface.\n\n${responseEnvelope}`,
  authSection,
  rateLimitSection('futures', true),
  errorSection,
  futuresWsSection,
  futuresUserData,
].join('\n\n');

export const PORTAL_API_DESCRIPTION = [
  `## Overview\n\nCross-product portal: auth, API-key management, subaccounts, deposits/withdrawals, and spot↔futures wallet transfers. Base URL \`http://localhost:5103\`. REST only — no WebSocket or Kafka.\n\n${responseEnvelope}`,
  authSection,
  subaccountSection,
  rateLimitSection('portal'),
  errorSection,
].join('\n\n');
