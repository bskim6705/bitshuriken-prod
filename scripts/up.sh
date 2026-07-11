#!/usr/bin/env bash
# 로컬 개발 스택 전체 기동: Docker(Kafka, Postgres) → Kafka 토픽 → BE → Match → FE.
# 각 앱은 별도 로그 파일로 백그라운드 실행. Ctrl-C로 일괄 종료.
#
# 사용: ./scripts/up.sh
#      ./scripts/up.sh --no-docker   (이미 docker compose up 된 경우)
#      ./scripts/up.sh --only be     (특정 서비스만; be|fe|match 조합)
#
# 로그: logs/<service>.log
# PID:  .run/<service>.pid

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/logs"
PID_DIR="$ROOT/.run"
mkdir -p "$LOG_DIR" "$PID_DIR"

# ---- args ----
SKIP_DOCKER=0
ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-docker) SKIP_DOCKER=1; shift ;;
    --only) ONLY="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

want() {
  [[ -z "$ONLY" || " $ONLY " == *" $1 "* ]]
}

# ---- helpers ----
color() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
info() { echo "$(color 36 "[up]") $*"; }
ok()   { echo "$(color 32 "[ok]") $*"; }
warn() { echo "$(color 33 "[!]")  $*"; }
err()  { echo "$(color 31 "[x]")  $*" >&2; }

wait_port() {
  local host="$1" port="$2" timeout="${3:-30}" name="$4"
  local waited=0
  until (echo > "/dev/tcp/$host/$port") >/dev/null 2>&1; do
    sleep 1
    waited=$((waited + 1))
    if (( waited >= timeout )); then
      err "$name: port $port not ready after ${timeout}s"
      return 1
    fi
  done
  ok "$name ready ($host:$port)"
}

start_bg() {
  local name="$1" cmd="$2" cwd="$3"
  local log="$LOG_DIR/$name.log"
  local pidfile="$PID_DIR/$name.pid"

  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    warn "$name already running (pid $(cat "$pidfile")). skip."
    return 0
  fi

  info "starting $name → $log"
  ( cd "$cwd" && eval "$cmd" ) >"$log" 2>&1 &
  echo $! > "$pidfile"
  ok "$name pid=$(cat "$pidfile")"
}

# pid의 자손 트리 전체 종료 — npm/nest 래퍼만 죽이면 node 손자가 포트를 계속 점유한다
kill_tree() {
  local p="$1" c
  for c in $(pgrep -P "$p" 2>/dev/null); do kill_tree "$c"; done
  kill "$p" 2>/dev/null || true
}

cleanup() {
  echo
  info "shutting down..."
  for pidfile in "$PID_DIR"/*.pid; do
    [[ -f "$pidfile" ]] || continue
    local name pid
    name="$(basename "$pidfile" .pid)"
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      info "stop $name (pid $pid)"
      kill_tree "$pid"
    fi
    rm -f "$pidfile"
  done
  ok "stopped"
}
trap cleanup INT TERM

# ---- preflight ----
command -v docker >/dev/null || { err "docker not found"; exit 1; }
command -v npm >/dev/null    || { err "npm not found"; exit 1; }
command -v jq >/dev/null     || { err "jq required (brew install jq)"; exit 1; }

# ---- docker ----
if (( SKIP_DOCKER == 0 )); then
  info "docker compose up -d"
  docker compose up -d
  wait_port localhost 5110 30 postgres
  wait_port localhost 5113 30 kafka
else
  info "skipping docker (--no-docker)"
fi

# ---- kafka topics ----
if (( SKIP_DOCKER == 0 )); then
  info "ensuring kafka topics"
  "$ROOT/scripts/create-kafka-topics.sh" >/dev/null || warn "topic creation returned non-zero"
fi

# ---- BE (spot/futures/portal 멀티앱) ----
if want be; then
  start_bg be-spot "npm run start:dev:spot" "$ROOT/bitshuriken-prod-be"
  start_bg be-futures "npm run start:dev:futures" "$ROOT/bitshuriken-prod-be"
  start_bg be-portal "npm run start:dev:portal" "$ROOT/bitshuriken-prod-be"
  wait_port localhost 5101 60 be-spot
  wait_port localhost 5102 60 be-futures
  wait_port localhost 5103 60 be-portal
fi

# ---- Match ----
if want match; then
  if [[ ! -d "$ROOT/bitshuriken-prod-match/venv" ]]; then
    err "python venv missing at bitshuriken-prod-match/venv. create it: python -m venv venv && pip install -r requirements.txt"
    exit 1
  fi
  # 프로드처럼 spot/futures 매칭엔진을 분리 기동한다. 단일 인스턴스 + 합본 tickers.json은
  # 양 마켓에 존재하는 심볼(BTCUSDT 등)에서 LaneRegistry가 심볼만으로 키잉해 lane이 충돌한다
  # (spot 주문이 futures lane에서 체결). 분리하면 각 인스턴스가 한 마켓만 담아 충돌이 없다.
  start_bg match-spot "source venv/bin/activate && MATCH_CONFIG_PATH=./config/tickers-spot.json python main.py" "$ROOT/bitshuriken-prod-match"
  start_bg match-futures "source venv/bin/activate && MATCH_CONFIG_PATH=./config/tickers-futures.json python main.py" "$ROOT/bitshuriken-prod-match"
fi

# ---- FE ----
if want fe; then
  start_bg fe "npm run dev" "$ROOT/bitshuriken-prod-fe"
  wait_port localhost 5100 60 fe
fi

echo
ok "stack up"
echo "  fe    : http://localhost:5100"
echo "  be    : spot http://localhost:5101 / futures http://localhost:5102 / portal http://localhost:5103  (docs: /docs)"
echo "  logs  : $LOG_DIR/"
echo "  stop  : Ctrl-C, or ./scripts/down.sh"

# 포그라운드 유지 (Ctrl-C 받기 위해)
while true; do
  sleep 3600 &
  wait $!
done
