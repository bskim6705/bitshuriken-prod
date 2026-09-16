#!/usr/bin/env bash
# 초파리 리그를 Ubuntu(24.04, x86_64) 기계에 원샷 배포한다 — 2012 Mac mini 같은 저사양도 대상.
#
#   git clone <repo> && cd bitshuriken-prod/bitshuriken-prod-fly
#   ./deploy/ubuntu-macmini.sh http://<거래소-호스트>:5101 http://<거래소-호스트>:5103     # 파리만 (거래소는 다른 기계)
#   ./deploy/ubuntu-macmini.sh --with-exchange                                          # 거래소 스택도 이 기계에 (infra compose 선행)
#
# 하는 일: docker 설치 확인(없으면 공식 apt 저장소로 설치) → 사양 측정(코어·RAM) → 파리 수 추천 → .env 작성(없을 때만)
# → 이미지 빌드 → 뇌 스텝 벤치 → recorder + league 기동 → 관전 URL 출력.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE=remote
SPOT_API=""; PORTAL_API=""
if [[ "${1:-}" == "--with-exchange" ]]; then MODE=local; else SPOT_API="${1:-}"; PORTAL_API="${2:-}"; fi
if [[ "$MODE" == remote && ( -z "$SPOT_API" || -z "$PORTAL_API" ) ]]; then
  echo "usage: $0 <SPOT_API> <PORTAL_API>   |   $0 --with-exchange" >&2; exit 2
fi

# ---- docker ----
if ! command -v docker >/dev/null; then
  echo "[deploy] installing Docker Engine (official apt repo)"
  sudo apt-get update -qq && sudo apt-get install -y -qq ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  sudo usermod -aG docker "$USER" && echo "[deploy] added $USER to docker group — re-login (or run: newgrp docker) before the next step"
fi
# 방금 설치했거나 그룹 반영 전이면 sudo로 진행
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"
$DOCKER compose version >/dev/null

# ---- 사양 → 추천값 ----
CORES=$(nproc); RAM_GB=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo)
if (( RAM_GB >= 15 && CORES >= 8 )); then FLIES=8; WORKERS=2; SEASON=30; RELEGATE=3
elif (( RAM_GB >= 7 )); then FLIES=6; WORKERS=1; SEASON=45; RELEGATE=2
else FLIES=4; WORKERS=1; SEASON=45; RELEGATE=1; fi
echo "[deploy] $CORES threads, ${RAM_GB}GB RAM → flies=$FLIES workers=$WORKERS season=${SEASON}min relegate=$RELEGATE (override in .env)"

# ---- .env ----
if [[ ! -f .env ]]; then
  cp .env.example .env
  if [[ "$MODE" == remote ]]; then
    sed -i "s#^SPOT_API=.*#SPOT_API=$SPOT_API#; s#^PORTAL_API=.*#PORTAL_API=$PORTAL_API#" .env
  fi
  sed -i "s#^FLY_FLIES=.*#FLY_FLIES=$FLIES#; s#^FLY_WORKERS=.*#FLY_WORKERS=$WORKERS#; s#^FLY_SEASON_MIN=.*#FLY_SEASON_MIN=$SEASON#; s#^FLY_RELEGATE=.*#FLY_RELEGATE=$RELEGATE#; s#^FLY_FIT_HOURS=.*#FLY_FIT_HOURS=1#; s#^FLY_BIND=.*#FLY_BIND=0.0.0.0#" .env
  echo "[deploy] wrote .env (edit MASTER_EMAIL/MASTER_PASSWORD if you want your own master account)"
fi

COMPOSE="docker-compose.yml"; [[ "$MODE" == remote ]] && COMPOSE="docker-compose.remote.yml"
echo "[deploy] building image ($COMPOSE)"
$DOCKER compose -f "$COMPOSE" build -q
echo "[deploy] connectome + brain-step benchmark on this machine (first run downloads FlyWire ~53MB)"
$DOCKER compose -f "$COMPOSE" run --rm --no-deps fly-league bench
echo "[deploy] starting recorder + league"
$DOCKER compose -f "$COMPOSE" up -d
IP=$(hostname -I | awk '{print $1}')
echo "[deploy] up. dashboard http://$IP:5130  — FE: NEXT_PUBLIC_FLY_API_URL=http://$IP:5130 ; logs: $DOCKER compose -f $COMPOSE logs -f fly-league"
