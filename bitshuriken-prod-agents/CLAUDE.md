# bitshuriken-prod-agents

멀티 전략 트레이딩 에이전트 프레임워크 — `bitshuriken-v2-agents`의 시맨틱 포크 (설계: v2 ADR-050
에이전트 프레임워크 / ADR-049 서브계정 / ADR-059 대시보드·정합성). TS/ESM, tsx 무빌드 실행.
(시스템 개요·서비스 간 계약은 상위 `../CLAUDE.md`.)

## 정체성 — 봇도 유저다 (feedback-025)
이 서비스는 거래소를 **외부에서 일반 유저로** 쓴다. 거래 행위는 실유저와 같은 표면만 탄다 —
공개 시세 API + 인증된 주문 API(HMAC API 키). **BE 내부 서비스 호출·DB 직접 쓰기·엔진 Kafka 직접
produce 금지.** 코어 스택 밖에서 붙는 별개 서비스이며 자기 배포 정의를 소유한다 (feedback-023).

## 핵심 모델 — 전략 하나 = 서브계정 하나
- 패키지는 단일 **마스터 계정**(JWT, signup-or-login)을 소유하며 마스터는 거래하지 않는다.
- 에이전트 생성: `POST /subaccounts` → 마스터 `POST /account/deposits` + `POST /subaccounts/transfers`로
  펀딩 → `POST /subaccounts/{id}/api-keys`(`canTrade/canRead`)로 HMAC 키 발급.
- 에이전트는 그 키로 거래·조회. 데이터는 서브계정 `userId`로 자동 격리 (prod ADR-049).

## HMAC 인증 (Binance 스타일 — BE `ApiKeyOnlyGuard`와 정확히 일치)
- canonical = `queryString(signature 제외) + body`, HMAC-SHA256 hex.
- 헤더 `X-API-KEY`; 쿼리 `timestamp`(epoch ms) / `recvWindow`(≤60000) / `signature`.
- 구현: `core/exchange.ts` `SubaccountClient.signed()`. 마스터 관리 호출은 JWT(Bearer) — `MasterClient`.
- 관리 표면(`/subaccounts`, `/auth/api-keys`)은 JWT 전용 (API 키 escalation 차단). 티커 활성화는
  `X-Admin-Secret` (`core/admin.ts` — `ServiceOrAdminGuard`).

## 브로커 — 한 전략, 라이브 + 백테스트
전략은 `ExecutionContext`로만 외부와 상호작용한다. 브로커를 바꾸면 같은 전략 파일이 무수정 구동:
- **LiveBroker** (`broker/live.ts`): HMAC REST. bar는 로컬 klines 폴링(`BarClock`), 포지션/equity는
  서브계정 잔고에서 매 bar 재동기. onFill은 `/account/trades` 폴링으로 방출(resting LIMIT 체결 → grid).
- **SimBroker** (`broker/sim.ts`): 과거 bar 대비 결정론적 체결(latency/slippage/fee) + cash/position ledger.
- 백테스트 이력은 Binance(ccxt `fetchOHLCV`, 페이지네이션)에서. 라이브 bar는 로컬 거래소에서.

## 정합성 (ADR-059 — 회계 교차검증)
격리 서브계정은 알려진 초기자본에서 한 심볼만 거래 → `/account/trades`를 초기자본부터 재생해 기대
잔고를 재구성하고 `/account/balances`와 대조. **drift = 정산/회계 버그**(수수료 quote/base 모델링).
+ 운영 헬스(running·연속에러·bar 신선도·equity 정상성). `metrics/integrity.ts`, `GET /integrity`, CLI `integrity`.

## SPOT 우선
라이브는 SPOT만 (ADR-004, futures 체결 갭). 라이브 `startAgent`가 FUTURES를 거부하고, 백테스트는
SimBroker라 무관하게 허용. 라이브 유동성은 **별개 bots 서비스**(feedback-023/025)가 `BOTS_DIR`에 있어야
mirror 스폰 가능. 티커 활성화(`ensureTradable`)는 bots 없이도 동작.

## 새 전략 추가
1. `src/strategies/<name>.ts`에 `StrategyFactory` default export (`{ id, paramSchema, create() }`).
2. `Strategy` 구현: `init` / `warmup` / `onBar` / `onTick?` / `onFill?` / `applyParams`.
   `OrderIntent`(`MARKET`/`MARKET_QUOTE`/`LIMIT`/`CANCEL`/`FLATTEN`)를 `ctx.submit()`.
3. `reload_strategies`(동적 import) → 등록. `run_backtest`로 검증 후 `start_agent`. 참고: `momentum.ts`.

## Precision (BE·매칭엔진 공유 규칙 — 상위 CLAUDE.md)
사람이 보는 값은 8자리 문자열. 클라이언트는 tick/step 스냅(`core/precision.ts`: price는 round, qty는 floor).
spot MARKET BUY는 `origQuoteQty`(quote 단위), 그 외는 `origQty`/`qty`(base). spot 주문 DTO는
`tickerSymbol`+`tickerMarket`, futures는 `symbol`.

## 토폴로지 / 실행
- **agentd** (`daemon.ts`): fleet·bar 소스·결과 저장소 소유, `node:http` 컨트롤 API + 대시보드(:5120).
- **CLI** (`cli.ts`) / **MCP** (`mcp.ts`): 컨트롤 API를 감싸는 얇은 클라이언트. 대시보드·컨트롤 API는
  인증 없음(내부 도구) — 외부 노출 금지.
- 결과는 JSON 파일(`DATA_DIR`, gitignore). 서브계정 키 secret도 평문 저장(재시작 후 resume, dev 한정).

```bash
npm install
cp .env.example .env
npm run daemon          # agentd (fleet + control API + dashboard :5120)
npm run cli <cmd>       # status / start / stop / tune / compare / integrity / backtest / scan ...
npm run backtest <strategyId> <symbol> <interval> <days> [k=v ...]   # 데몬 불필요
npm run typecheck       # tsc --noEmit
```

## 작업 규칙 (상위 규칙 준수)
- 요청 범위만, 미리 구현 금지 (feedback-001). 정책 결정(레이트리밋 면제 등)은 유저 확정 후 (feedback-016).
- 정책·상수는 .env 아니라 코드 (feedback-020). 런타임 조회 가능한 목록 하드코딩 금지 (feedback-021) —
  심볼은 exchange-info, 전략은 registry에서.
- 주석은 핵심만 짧게 self-contained, ADR 번호 코드에 안 박음 (feedback-009).
