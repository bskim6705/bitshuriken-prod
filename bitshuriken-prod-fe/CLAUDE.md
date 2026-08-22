@AGENTS.md

# bitshuriken-prod-fe

Bitshuriken 프론트엔드 — Next.js (port 5100). spot/futures/portal 백엔드를 호출하는 거래소 UI. (시스템 개요·서비스 간 계약은 상위 `../CLAUDE.md`.)

> 위 `@AGENTS.md`: 이 Next.js는 학습 데이터와 다를 수 있다 — 코드 작성 전 `node_modules/next/dist/docs/`의 관련 가이드를 먼저 읽어라.

## 백엔드 연결
- `src/lib/api/client.ts`가 `api`(spot) / `futuresApi` / `portalApi`를 export. 세 개의 `NEXT_PUBLIC_{API,FUTURES_API,PORTAL_API}_URL`을 **import 시점에 요구**(없으면 throw) — dev `.env`에 셋 다 있어야 부팅한다.
- 모든 fetch는 `credentials: "include"`. 429/418은 `Retry-After` 존중 백오프.

## 컨벤션
- 거래소 UI는 **거래소 컨벤션**을 따른다 — 아트 디렉션/과한 디자인 금지 (docs/feedback/010). 랜딩/카피 톤은 차분한 프로 (docs/feedback/011).
- UI 텍스트는 전부 다국어화. `src/lib/i18n/messages/<area>.ts`에 area별 `defineMessages({en,ko,ja,zh})`, 컴포넌트는 `useT()`. **신규 문자열 = 영역 모듈에 4개 언어 + `t("area.key")`**. 하드코딩 문자열 금지.
- market 데이터는 공개, 로그인은 private 액션(주문/지갑/계정)에서만 요구 (docs/feedback/017).
- 도메인 데이터(심볼·정밀도·수수료 등)는 DB/API에서 받는다 — const 하드코딩 금지 (docs/feedback/015·021).
- WS 클라이언트는 `BaseWsClient` 상속.
- `MarketType = "SPOT" | "FUTURES"` (`src/lib/types/market.ts`). 브랜딩·localStorage 키(`bitshuriken_*`)는 그대로 유지.

## Test / build
```bash
npm run dev              # port 5100 (NEXT_PUBLIC_* 3개 필요)
npx tsc --noEmit         # 타입 게이트
npm run lint
npm run build            # next build (URL env 3개로 검증 가능)
```
`src/lib/i18n/messages/index.ts`가 area 모듈을 로케일별 단일 사전으로 병합 — `en` 스프레드가 `TranslationKey` 유니온을 도출하므로, 새 키는 4개 로케일 전부에 있어야 tsc를 통과한다. ADR/피드백은 상위 `../docs/`.
