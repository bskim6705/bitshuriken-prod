#!/usr/bin/env bash
# up.sh가 띄운 프로세스와 docker compose 전체 종료.
#
# 사용: ./scripts/down.sh
#      ./scripts/down.sh --keep-docker   (앱만 종료, docker는 유지)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

KEEP_DOCKER=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-docker) KEEP_DOCKER=1; shift ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

color() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info() { echo "$(color 36 "[down]") $*"; }
ok()   { echo "$(color 32 "[ok]")   $*"; }

# pid의 자손 트리 전체 종료 — npm/nest 래퍼만 죽이면 node 손자가 포트를 계속 점유한다
kill_tree() {
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done
  kill "$p" 2>/dev/null || true
}

PID_DIR="$ROOT/.run"
if [[ -d "$PID_DIR" ]]; then
  for pidfile in "$PID_DIR"/*.pid; do
    [[ -f "$pidfile" ]] || continue
    name="$(basename "$pidfile" .pid)"
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      info "stop $name (pid $pid)"
      kill_tree "$pid"
    fi
    rm -f "$pidfile"
  done
fi

if (( KEEP_DOCKER == 0 )); then
  info "docker compose down"
  docker compose down
fi

ok "stack down"
