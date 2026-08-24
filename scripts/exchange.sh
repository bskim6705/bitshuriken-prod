#!/usr/bin/env bash
# 거래소 라이프사이클 툴 — 시작/정지/초기화가 "검증될 때까지" 끝나지 않는다.
#
# 사용:
#   ./scripts/exchange.sh start    # 인프라→토픽→BE→엔진→FE 기동, 각 단계 실제 서빙 검증
#   ./scripts/exchange.sh stop     # 스택+봇+에이전트 전 프로세스 종료 검증 (docker는 유지)
#   ./scripts/exchange.sh reset    # stop → docker 볼륨 초기화 → 토픽 재생성 → migrate+seed → 검증
#   ./scripts/exchange.sh status   # 컴포넌트별 liveness/포트/토픽 상태
#
# 설계 원칙 (2026-07-13 사고에서 도출):
# - 검증은 전부 기능 기반: 포트 체크는 curl(zsh /dev/tcp 오탐 금지), DB는 pg_isready,
#   Kafka는 kafka-topics 응답. "프로세스가 떠 있다"는 성공이 아니다.
# - 토픽은 반드시 앱보다 먼저. Kafka 준비 전 앱이 붙으면 1-파티션 auto-create돼
#   lane 매핑이 깨진다. start는 파티션 수까지 검증하고 불일치면 실패한다(reset 안내).
# - stop은 패턴 킬 후 "실제로 죽었는지" 재확인. 외부 슈퍼바이저(과거 세션 잔재 등)가
#   되살리는 것까지 감지해 경고한다.
# - 엔진은 venv python을 절대경로로 직접 실행(PYTHONUNBUFFERED=1) — ps로 식별 가능하고
#   로그가 버퍼링으로 사라지지 않는다. 기동 후 N초 생존 + "match started" 로그까지 확인.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
LOG_DIR="$ROOT/logs"; PID_DIR="$ROOT/.run"
mkdir -p "$LOG_DIR" "$PID_DIR"

# node 경로 고정 (launchd/cron/비로그인 셸에서도 npm이 잡히도록)
if ! command -v npm >/dev/null 2>&1; then
  NVM_LATEST="$(ls -d "$HOME"/.nvm/versions/node/* 2>/dev/null | sort -V | tail -1)"
  [[ -n "${NVM_LATEST:-}" ]] && export PATH="$NVM_LATEST/bin:$PATH"
fi

KAFKA_CONTAINER="bitshuriken-prod-kafka-1"
PG_CONTAINER="bitshuriken-prod-postgres-1"
P="${MATCH_PARTITIONS:-6}"
VENV_PY="$ROOT/bitshuriken-prod-match/venv/bin/python"

c(){ printf '\033[%sm%s\033[0m' "$1" "$2"; }
info(){ echo "$(c 36 "[exchange]") $*"; }
ok(){ echo "$(c 32 "[ok]") $*"; }
warn(){ echo "$(c 33 "[!]") $*"; }
die(){ echo "$(c 31 "[FAIL]") $*" >&2; exit 1; }

# ---------- 검증 헬퍼 ----------
wait_http(){ # url expect_pattern timeout_s name
  local url="$1" timeout="$3" name="$4" t=0 code
  while (( t < timeout )); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" 2>/dev/null)"
    [[ "$code" =~ $2 ]] && { ok "$name serving (HTTP $code)"; return 0; }
    sleep 2; t=$((t+2))
  done
  return 1
}
wait_pg(){ local t=0; while (( t < ${1:-120} )); do docker exec "$PG_CONTAINER" pg_isready -U bitshuriken -q 2>/dev/null && { ok "postgres ready"; return 0; }; sleep 2; t=$((t+2)); done; return 1; }
wait_kafka(){ local t=0; while (( t < ${1:-180} )); do docker exec "$KAFKA_CONTAINER" kafka-topics --bootstrap-server localhost:5113 --list >/dev/null 2>&1 && { ok "kafka ready"; return 0; }; sleep 2; t=$((t+2)); done; return 1; }

topic_partitions(){ docker exec "$KAFKA_CONTAINER" kafka-topics --bootstrap-server localhost:5113 --describe --topic "$1" 2>/dev/null | head -1 | sed -n 's/.*PartitionCount: *\([0-9]*\).*/\1/p'; }

verify_topics(){ # 전 match 토픽 존재 + 파티션 수 일치 확인
  local bad=0 m t want got
  for m in spot futures; do
    for t in in out book state control; do
      want=$P; [[ "$t" == control ]] && want=1
      got="$(topic_partitions "match.$m.$t")"
      if [[ "$got" != "$want" ]]; then warn "match.$m.$t partitions=$got (want $want)"; bad=1; fi
    done
  done
  return $bad
}

create_topics(){ # 생성만 (--if-not-exists)
  KAFKA_CONTAINER="$KAFKA_CONTAINER" "$ROOT/scripts/create-kafka-topics.sh" >/dev/null 2>&1 || true
}

ensure_topics(){ # 자가 치유: 생성→검증→불일치 토픽만 삭제·재생성, 3회 시도
  local round m t want got bad
  for round in 1 2 3; do
    create_topics
    bad=0
    for m in spot futures; do
      for t in in out book state control; do
        want=$P; [[ "$t" == control ]] && want=1
        got="$(topic_partitions "match.$m.$t")"
        if [[ "$got" != "$want" ]]; then
          warn "round $round: match.$m.$t partitions=${got:-missing} (want $want) — recreating"
          docker exec "$KAFKA_CONTAINER" kafka-topics --bootstrap-server localhost:5113 --delete --topic "match.$m.$t" >/dev/null 2>&1
          bad=1
        fi
      done
    done
    if [[ $bad == 0 ]]; then ok "topics verified (P=$P)"; return 0; fi
    sleep 3
  done
  return 1
}

# ---------- 프로세스 관리 ----------
# 스택 전체를 식별하는 정밀 패턴 (다른 프로젝트/에디터 오살 방지)
PATTERNS=(
  "$ROOT/scripts/up.sh"
  # BE: 실제 argv는 상대경로 "node dist/apps/<app>/main" (cwd=BE 레포). 레포경로 접두사로
  # pgrep/pkill하면 절대 안 잡혀 old BE가 안 죽고 포트를 계속 점유 → 새 start:prod가 bind
  # 실패로 조용히 죽고 verify는 OLD 프로세스(HTTP 200)에 통과 → 재빌드가 무통보 미배포
  # (2026-07-16 관찰 #27). 상대 argv(node) + npm 래퍼 둘 다 매칭. start:dev는 안 잡힌다.
  "dist/apps/(spot|futures|portal|settle)/main"
  "npm run start:prod:(spot|futures|portal|settle)"
  "bitshuriken-prod-be/node_modules/.bin/nest"
  "bitshuriken-prod-fe/node_modules/.bin/next"
  "bitshuriken-match-(spot|futures)"
  "MacOS/Python main.py"
  "bitshuriken-prod-bots/node_modules"
  "bitshuriken-prod-agents/node_modules"
)
# 함정 (2026-07-13 실측): macOS venv python은 프레임워크 바이너리로 재-exec돼
# ps에 ".../MacOS/Python main.py"로 표시된다 — venv 경로로 pgrep하면 절대 안 잡히고,
# "죽었다" 오판 → 재기동 반복 → 엔진 22개 스웜으로 파티션이 쪼개졌다. 그래서 엔진은
# 무해한 마커 argv("bitshuriken-match-<market>", main.py는 argv 미사용)를 붙여 식별한다.

kill_all(){
  local pat killed=0
  for pat in "${PATTERNS[@]}"; do pkill -f "$pat" 2>/dev/null && killed=1; done
  pkill -f "npm run bots" 2>/dev/null && killed=1
  # nest watch가 정지 전 스폰한 node 자식(dist/main)도 훑는다
  sleep 2
  for pat in "${PATTERNS[@]}"; do pkill -9 -f "$pat" 2>/dev/null; done
  free_be_ports   # 포트로 남은 BE 리스너 확실히 정리 (상대 argv가 패턴을 빠져나가도 bind 확보)
  rm -f "$PID_DIR"/*.pid
  local t=0 c
  while (( t < 15 )); do
    c=$(alive_count)
    [[ "$c" == "0" ]] && { ok "all processes down"; return 0; }
    sleep 1; t=$((t+1))
  done
  die "processes still alive after kill: $(alive_list)"
}

alive_list(){ for pat in "${PATTERNS[@]}"; do pgrep -fl "$pat" 2>/dev/null; done | sort -u; }
alive_count(){ alive_list | wc -l | tr -d ' '; }

# BE 포트로 직접 식별/정리 — 상대 argv가 패턴을 빠져나가도 bind 전 포트 확보를 보장.
# (포트 5101/5102/5103은 이 거래소 전용) 함정: 재빌드 전 old 리스너가 포트를 안 놓으면
# 새 start:prod가 bind 실패로 조용히 죽고 verify는 old에 통과한다 (관찰 #27).
BE_PORTS=(5101 5102 5103 5104)
port_pid(){ lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null | head -1; } # 해당 포트 LISTEN pid (없으면 빈값)
free_be_ports(){ # BE 포트를 잡은 잔여 리스너를 TERM→KILL
  local port lp
  for port in "${BE_PORTS[@]}"; do lp="$(port_pid "$port")"; [[ -n "$lp" ]] && kill "$lp" 2>/dev/null; done
  sleep 1
  for port in "${BE_PORTS[@]}"; do lp="$(port_pid "$port")"; [[ -n "$lp" ]] && kill -9 "$lp" 2>/dev/null; done
}
is_descendant(){ # child ancestor — child의 ppid 체인에 ancestor가 있으면 0
  local p="$1" anc="$2" g=0
  while [[ -n "$p" && "$p" != 0 && "$p" != 1 && $g -lt 20 ]]; do
    [[ "$p" == "$anc" ]] && return 0
    p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"; g=$((g+1))
  done
  [[ "$p" == "$anc" ]]
}
assert_be_listener(){ # name port pidfile — HTTP OK 이후, 포트를 잡은 pid가 이번에 스폰한 래퍼의 자손인지 확인
  local name="$1" port="$2" pidfile="$3" want lp
  want="$(cat "$pidfile" 2>/dev/null)"
  lp="$(port_pid "$port")"
  [[ -n "$lp" ]] || die "$name: HTTP는 통과인데 :$port LISTEN 프로세스가 없다 — 스폰 실패(외부 리스너가 응답?). logs/$name.log"
  if [[ -z "$want" ]] || ! is_descendant "$lp" "$want"; then
    die "$name: :$port를 STALE pid $lp가 점유 중 (이번 스폰=${want:-?}의 자손 아님) — 재빌드가 배포되지 않았다. 조치: kill -9 $lp 후 start 재실행"
  fi
  ok "$name fresh (listen pid $lp ⇐ spawn $want)"
}

start_component(){ # name cmd cwd — nohup 실행 + pid 기록
  local name="$1" cmd="$2" cwd="$3"
  ( cd "$cwd" && exec nohup bash -c "$cmd" >"$LOG_DIR/$name.log" 2>&1 ) &
  echo $! > "$PID_DIR/$name.pid"
}

# ---------- start ----------
do_start(){
  command -v docker >/dev/null || die "docker not found"
  command -v npm >/dev/null || die "npm not found (nvm 미설치?)"
  [[ -x "$VENV_PY" ]] || die "match venv missing: $VENV_PY"

  # 0) 잔재 정리: 이미 뭔가 떠 있으면 (부분 기동/좀비) 전부 내리고 깨끗하게 시작
  if [[ "$(alive_count)" != "0" ]]; then
    warn "live processes found — cleaning first: $(alive_list | head -3)"
    kill_all
  fi

  # 1) 인프라
  info "docker compose up -d"
  docker compose up -d >/dev/null 2>&1 || die "docker compose up failed"
  wait_pg 120 || die "postgres not ready in 120s"
  wait_kafka 180 || die "kafka not ready in 180s"

  # 2) 토픽 — 앱보다 먼저 (auto-create 오염 방지). 파티션 불일치는 자가 치유.
  #    주의: 데이터가 있는 토픽 재생성은 상태 소실 — 빈 토픽일 때만 안전하므로
  #    running 컨슈머가 남아있으면 위 kill_all이 이미 제거한 상태다.
  ensure_topics || die "kafka topics unfixable — run: ./scripts/exchange.sh reset"

  # 3) BE 3앱 — dist 빌드 실행 (--watch 금지: 소스 저장이 라이브 스택을 무통보 재기동시켜
  #    정산 유실·레인 무반응을 유발한 2026-07-14 사고의 근본 원인. 코드 반영은 재기동으로만.)
  ( cd "$ROOT/bitshuriken-prod-be" && npm run build >"$LOG_DIR/be-build.log" 2>&1 ) \
    || die "be build failed — logs/be-build.log"
  ok "be built (dist)"
  start_component be-spot    "npm run start:prod:spot"    "$ROOT/bitshuriken-prod-be"
  start_component be-futures "npm run start:prod:futures" "$ROOT/bitshuriken-prod-be"
  start_component be-portal  "npm run start:prod:portal"  "$ROOT/bitshuriken-prod-be"
  start_component be-settle  "npm run start:prod:settle"  "$ROOT/bitshuriken-prod-be"
  # HTTP 통과만으로는 부족: old BE가 포트를 쥔 채 응답하면 재빌드가 미배포돼도 200이 나온다.
  # 포트를 실제로 잡은 pid가 방금 스폰한 래퍼의 자손인지 확인해 무통보 미배포를 차단 (관찰 #27).
  wait_http "http://localhost:5101/spot/market/depth?symbol=BTCUSDT" "^200$" 300 be-spot    || die "be-spot dead — logs/be-spot.log"
  assert_be_listener be-spot    5101 "$PID_DIR/be-spot.pid"
  wait_http "http://localhost:5102/docs" "^(200|301|302)$" 120 be-futures || die "be-futures dead — logs/be-futures.log"
  assert_be_listener be-futures 5102 "$PID_DIR/be-futures.pid"
  wait_http "http://localhost:5103/docs" "^(200|301|302)$" 120 be-portal  || die "be-portal dead — logs/be-portal.log"
  assert_be_listener be-portal  5103 "$PID_DIR/be-portal.pid"
  # settle(M1): 정산 티어 — 엔진보다 먼저 떠야 신규 그룹이 out 토픽을 처음부터 잡는다
  wait_http "http://localhost:5104/health" "^200$" 120 be-settle || die "be-settle dead — logs/be-settle.log"
  assert_be_listener be-settle  5104 "$PID_DIR/be-settle.pid"

  # 4) 매칭엔진 2instance — argv[0]을 exec -a로 식별명 강제 (위 함정 참조),
  #    인스턴스별 생존+로그 검증, 3회 재시도. 중복 인스턴스는 파티션을 쪼개므로
  #    시작 전 반드시 0이어야 한다 (kill_all이 보장).
  local m cfg tries
  for m in spot futures; do
    cfg="./config/tickers-$m.json"
    for tries in 1 2 3; do
      start_component "match-$m" "MATCH_CONFIG_PATH=$cfg PYTHONUNBUFFERED=1 exec $VENV_PY main.py bitshuriken-match-$m" "$ROOT/bitshuriken-prod-match"
      sleep 8
      if grep -q "match started" "$LOG_DIR/match-$m.log" 2>/dev/null && pgrep -f "bitshuriken-match-$m" >/dev/null; then
        ok "match-$m up (try $tries)"; break
      fi
      warn "match-$m failed try $tries — $(tail -1 "$LOG_DIR/match-$m.log" 2>/dev/null)"
      [[ $tries == 3 ]] && die "match-$m won't start — logs/match-$m.log"
    done
  done
  # 정확히 인스턴스 1개씩인지 최종 확인 (스웜 방지)
  sleep 5
  for m in spot futures; do
    local n; n="$(pgrep -f "bitshuriken-match-$m" | wc -l | tr -d ' ')"
    [[ "$n" == "1" ]] || die "match-$m instance count=$n (want exactly 1) — logs/match-$m.log"
  done
  ok "match engines alive: spot=1 futures=1"

  # 5) FE
  start_component fe "npm run dev" "$ROOT/bitshuriken-prod-fe"
  wait_http "http://localhost:5100" "^200$" 120 fe || die "fe dead — logs/fe.log"

  # 6) 외부 간섭 감시 (15s 뒤): 정상 dist(node)의 PPID는 스폰한 npm 래퍼다.
  #    PPID=1(고아) dist main = 죽은 래퍼의 잔재 or 외부 슈퍼바이저 소행 → 실패.
  sleep 15
  local orphan
  orphan="$(ps -o pid,ppid,command -ax | awk '$2==1 && /dist\/apps\/(spot|futures|portal|settle)\/main/ {print $1}' | wc -l | tr -d ' ')"
  [[ "$orphan" != "0" ]] && die "orphaned dist-build BE detected ($orphan) — 죽은 래퍼 잔재 or 외부 슈퍼바이저. ps -o pid,ppid,command -ax | grep dist/apps 확인"

  ok "EXCHANGE UP — fe:5100 spot:5101 futures:5102 portal:5103 settle:5104"
}

# ---------- stop ----------
# 단계화된 정지 (F0): 봇 INT → BE TERM+드레인 대기 → 엔진 TERM(최종 스냅샷) → 에스컬레이션.
# BE는 enableShutdownHooks로 SIGTERM에서 컨슈머 정지→워커 quiesce→disconnect를 자체 수행하고,
# 엔진은 SIGTERM에서 dirty lane 최종 스냅샷+flush 후 종료한다 — 무순서 pkill은 그 전부를 찢었다.
wait_gone(){ # pattern timeout_s — 패턴이 사라질 때까지 대기, 성공 0
  local pat="$1" t=0 max="$2"
  while (( t < max )); do
    pgrep -f "$pat" >/dev/null 2>&1 || return 0
    sleep 1; t=$((t+1))
  done
  return 1
}

graceful_stop(){
  # ① 봇/에이전트: 피더부터 끊는다 (INT — 봇의 자체 정리: 메이커 주문 취소+검증)
  pkill -INT -f "bitshuriken-prod-bots/node_modules" 2>/dev/null
  pkill -INT -f "npm run bots" 2>/dev/null
  pkill -INT -f "bitshuriken-prod-agents/node_modules" 2>/dev/null
  wait_gone "bitshuriken-prod-bots/node_modules" 30 || info "bots still alive after 30s — will escalate"

  # ② BE: TERM → 셧다운 시퀀스(신규 요청 거부·컨슈머 정지·워커 quiesce) 완료 대기
  pkill -f "dist/apps/(spot|futures|portal|settle)/main" 2>/dev/null
  pkill -f "npm run start:prod:(spot|futures|portal|settle)" 2>/dev/null
  wait_gone "dist/apps/(spot|futures|portal|settle)/main" 30 || info "BE still alive after 30s — will escalate"

  # ③ settle: BE(주문 유입) 정지 후 → 정산 드레인·컨슈머 오프셋 플러시 대기
  pkill -f "dist/apps/settle/main" 2>/dev/null
  pkill -f "npm run start:prod:settle" 2>/dev/null
  wait_gone "dist/apps/settle/main" 30 || info "settle still alive after 30s — will escalate"

  # ④ 엔진: TERM → 최종 스냅샷 발행+flush 완료 대기
  pkill -f "bitshuriken-match-(spot|futures)" 2>/dev/null
  pkill -f "MacOS/Python main.py" 2>/dev/null
  wait_gone "bitshuriken-match-(spot|futures)" 20 || info "engines still alive after 20s — will escalate"
}

do_stop(){
  graceful_stop
  kill_all   # 잔여물 에스컬레이션(-9)·포트 정리 — 위 단계가 성공했으면 사실상 no-op
  # 좀비 슈퍼바이저 감시: 20s 안에 무언가 되살아나면 외부 간섭 존재
  sleep 20
  if [[ "$(alive_count)" != "0" ]]; then
    die "something RESPAWNED after stop: $(alive_list | head -5) — 외부 슈퍼바이저를 먼저 제거하라"
  fi
  ok "EXCHANGE DOWN (docker infra는 유지 — 완전 정지는 docker compose down)"
}

# ---------- reset ----------
do_reset(){
  do_stop
  info "wiping docker volumes (postgres + kafka)"
  docker compose down -v >/dev/null 2>&1 || die "compose down -v failed"
  docker compose up -d >/dev/null 2>&1 || die "compose up failed"
  wait_pg 120 || die "postgres not ready"
  wait_kafka 180 || die "kafka not ready"

  # 토픽 생성 + 검증 (fresh broker 직후 생성이 1-파티션으로 어긋나는 레이스 실측 —
  # 2026-07-13 — 자가 치유 루프로 흡수)
  ensure_topics || die "topic creation failed after 3 rounds"

  info "prisma migrate deploy + db seed"
  ( cd "$ROOT/bitshuriken-prod-be" && npx prisma migrate deploy >/dev/null 2>&1 ) || die "migrate deploy failed"
  ( cd "$ROOT/bitshuriken-prod-be" && npx prisma db seed >/dev/null 2>&1 ) || die "db seed failed"

  # 시드 검증: 티커/유저 수
  local tickers users
  tickers="$(docker exec "$PG_CONTAINER" psql -U bitshuriken -d bitshuriken -tAc 'SELECT count(*) FROM "Ticker";' 2>/dev/null)"
  users="$(docker exec "$PG_CONTAINER" psql -U bitshuriken -d bitshuriken -tAc 'SELECT count(*) FROM "User";' 2>/dev/null)"
  [[ "${tickers:-0}" -ge 100 ]] || die "seed verification failed: tickers=$tickers"
  ok "RESET COMPLETE — tickers=$tickers users=$users. 다음: ./scripts/exchange.sh start"
}

# ---------- status ----------
do_status(){
  echo "== processes =="
  alive_list | sed 's/^/  /' || true
  echo "== ports (기능 엔드포인트 HTTP 코드) =="
  printf "  %-12s %s\n" fe         "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 'http://localhost:5100' 2>/dev/null)"
  printf "  %-12s %s\n" be-spot    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 'http://localhost:5101/spot/market/depth?symbol=BTCUSDT' 2>/dev/null)"
  printf "  %-12s %s\n" be-futures "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 'http://localhost:5102/docs' 2>/dev/null)"
  printf "  %-12s %s\n" be-portal  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 'http://localhost:5103/docs' 2>/dev/null)"
  printf "  %-12s %s\n" be-settle  "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 'http://localhost:5104/health' 2>/dev/null)"
  echo "== engines (want 1 each) =="
  printf "  match-spot: %s  match-futures: %s\n" \
    "$(pgrep -f 'bitshuriken-match-spot' | wc -l | tr -d ' ')" \
    "$(pgrep -f 'bitshuriken-match-futures' | wc -l | tr -d ' ')"
  echo "== topics =="
  verify_topics && echo "  all correct (P=$P)" || echo "  MISMATCH — reset needed"
  echo "== db =="
  printf "  trades: %s\n" "$(docker exec "$PG_CONTAINER" psql -U bitshuriken -d bitshuriken -tAc 'SELECT count(*) FROM "Trade";' 2>/dev/null || echo 'n/a')"
}

case "${1:-}" in
  start) do_start ;;
  stop) do_stop ;;
  reset) do_reset ;;
  status) do_status ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac
