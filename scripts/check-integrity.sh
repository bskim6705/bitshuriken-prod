#!/usr/bin/env bash
# 정합성(F1~F4)은 봇 트레이딩과 분리해 정산이 드레인된 상태에서 측정한다 (docs/feedback/026).
# 거래소 정산은 async(매칭엔진 → Kafka → 정산 워커)라, 활발히 트레이딩하는 중에는 "체결은 기록됐지만
# 지갑/락이 아직 미반영"인 in-flight 상태를 point-in-time 체커가 잡아 F1b/F1c/F4가 일시적 red를
# 깜빡인다(금전 사고 아님 — 정지 시 항상 0 fail). 그래서 측정 전 봇 주문 흐름을 멈추고 드레인한다.
#
# 흐름: 봇 주문 흐름 정지(maker가 자기 주문 취소 → 락 해제) → 정산 드레인 → F1~F4 측정.
# 봇은 정지된 채로 남는다 (다음 측정 세션은 bitshuriken-prod-bots에서 `npm run bots`로 재기동).
#
# 사용: ./scripts/check-integrity.sh [드레인초=20]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRAIN="${1:-20}"

color() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info() { echo "$(color 36 "[chk]") $*"; }
ok()   { echo "$(color 32 "[ok]")  $*"; }
err()  { echo "$(color 31 "[x]")   $*" >&2; }

command -v npm >/dev/null || { err "npm not found (nvm 셸에서 실행)"; exit 1; }

# 1) 봇 주문 흐름 정지 — SIGINT면 maker가 자기 주문을 취소해 락을 해제한다.
if pgrep -f "src/run.ts" >/dev/null 2>&1; then
  info "봇 주문 흐름 정지 (SIGINT)…"
  pkill -INT -f "src/run.ts" 2>/dev/null || true
  for _ in $(seq 1 25); do pgrep -f "src/run.ts" >/dev/null 2>&1 || break; sleep 1; done
  ok "봇 정지"
else
  info "실행 중인 봇 없음 — 바로 측정"
fi

# 2) 정산 드레인
info "정산 드레인 ${DRAIN}s…"
sleep "$DRAIN"

# 3) F1~F4 측정 (exit 1 on monetary fail)
info "정합성 측정 (F1~F4)…"
cd "$ROOT/bitshuriken-prod-bots"
exec npm run check
