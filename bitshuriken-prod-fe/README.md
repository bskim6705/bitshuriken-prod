# bitshuriken-prod-fe

Bitshuriken 거래소 프론트엔드 — Next.js 16 (App Router) · React 19 · TanStack Query · Tailwind v4. 포트 **5100**.
시스템 개요와 서비스 간 계약은 상위 [CLAUDE.md](../CLAUDE.md), FE 컨벤션은 [CLAUDE.md](CLAUDE.md).

## 실행

```bash
npm install
# .env — 세 API 주소가 import 시점에 필수(없으면 throw)
#   NEXT_PUBLIC_API_URL / NEXT_PUBLIC_FUTURES_API_URL / NEXT_PUBLIC_PORTAL_API_URL
npm run dev            # http://localhost:5100
npm run build && npm start
npm run lint
npx tsc --noEmit
```

전체 스택(BE·엔진·인프라 포함)은 루트 `./scripts/exchange.sh start`가 정본이다.

## 구조

- `src/app` — App Router 라우트: `markets`, `trade/[symbol]`, `futures/[symbol]`, `wallet`, `orders`, `account`, `admin`, `api-docs`
- `src/components` — 영역별 컴포넌트. `common/`은 spot·futures 공용, `ui/`는 프리미티브
- `src/lib` — `api/`(spot·futures·portal 클라이언트), `hooks/`(TanStack Query + WS), `ws/`, `i18n/`(en·ko·ja·zh), `types/`, `product-stages.ts`(ADR-076: futures beta 표시)

## 배포

Docker standalone 이미지. `NEXT_PUBLIC_*`는 빌드 시 인라인되므로 루트 `.github/workflows/release-fe.yml`이 리포지토리 Variables에서 주입한다(ADR-062 §6). 같은 오리진 `/api/*`를 nginx가 앱별로 라우팅한다.
