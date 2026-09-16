#!/usr/bin/env sh
# 커넥톰 바이너리가 없으면 FlyWire 원본을 내려받아 굽고(1회), 그 다음 fly 서브커맨드를 실행한다.
set -e
if [ ! -f "${DATA_DIR:-/app/data}/fafb783-central.flybrain" ]; then
  echo "[entrypoint] connectome missing — building (downloads ~53MB from FlyWire once)"
  npx tsx src/cli.ts build
fi
exec npx tsx src/cli.ts "$@"
