#!/usr/bin/env bash
# Create match.{spot,futures}.{in,out,book,state,control}. Runs once on each `up`
# (idempotent: --if-not-exists). state/control are log-compacted; control = 1 partition.
set -euo pipefail

BROKER="kafka:9092"
KT="/opt/kafka/bin/kafka-topics.sh"
# 파티션 수 = 버킷 수 P (심볼 수가 아님 — 심볼은 FNV-1a(symbol)%P로 버킷에 배정).
SP="${MATCH_SPOT_PARTITIONS:-6}"
FP="${MATCH_FUTURES_PARTITIONS:-6}"

create() {
  local topic="$1" parts="$2"; shift 2
  echo ">> $topic (partitions=$parts)"
  "$KT" --bootstrap-server "$BROKER" --create --if-not-exists \
    --topic "$topic" --partitions "$parts" --replication-factor 1 "$@"
}

for spec in "spot:$SP" "futures:$FP"; do
  m="${spec%%:*}"; p="${spec##*:}"
  create "match.$m.in"      "$p"
  create "match.$m.out"     "$p"
  create "match.$m.book"    "$p"
  create "match.$m.state"   "$p" --config cleanup.policy=compact
  # control: 런타임 상장(ADD). 1 partition, key=symbol, compacted (재시작 후에도 추가분 보존).
  create "match.$m.control" 1    --config cleanup.policy=compact
done

echo "topics ready:"
"$KT" --bootstrap-server "$BROKER" --list | grep '^match\.' || true
