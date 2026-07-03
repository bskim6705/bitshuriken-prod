#!/usr/bin/env bash
# Pull the latest GHCR images and (re)deploy. Run on the host (manually, or via
# the systemd timer). `be-migrate` runs prisma migrate deploy before the apps
# start (compose depends_on), so this is safe to run repeatedly.
#
#   ./deploy.sh
#
# Prereq (once): docker login ghcr.io (the images are private). See README.
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE=(docker compose -f docker-compose.prod.yml --env-file .env.prod)

"${COMPOSE[@]}" pull
"${COMPOSE[@]}" up -d --remove-orphans
docker image prune -f >/dev/null 2>&1 || true

echo "deploy done"
