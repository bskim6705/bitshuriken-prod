#!/usr/bin/env bash
# Kafka 토픽 생성. 버킷 수 P(기본 6)만큼 partition — 심볼은 FNV-1a(symbol)%P로 버킷 배정.
# match.{spot|futures}.{in|out|book|state|control} 10개를 만든다.
# state/control은 log-compacted (엔진 스냅샷/런타임 상장, key=symbol); control은 1 partition.
#
# 사용: ./scripts/create-kafka-topics.sh
# 전제: docker compose up -d (kafka 컨테이너 실행 중)

set -euo pipefail

CONTAINER="${KAFKA_CONTAINER:-bitshuriken-prod-kafka-1}"
BROKER="${KAFKA_BROKER:-localhost:5113}"

create_topic() {
  local topic="$1"
  local partitions="$2"
  shift 2
  echo ">> $topic (partitions=$partitions)"
  docker exec "$CONTAINER" kafka-topics \
    --bootstrap-server "$BROKER" \
    --create --if-not-exists \
    --topic "$topic" \
    --partitions "$partitions" \
    --replication-factor 1 \
    "$@"
}

P="${MATCH_PARTITIONS:-6}"

for m in spot futures; do
  create_topic "match.$m.in"      "$P"
  create_topic "match.$m.out"     "$P"
  create_topic "match.$m.book"    "$P"
  create_topic "match.$m.state"   "$P" --config cleanup.policy=compact
  create_topic "match.$m.control" 1    --config cleanup.policy=compact
done

echo
echo "Done. Listing topics:"
docker exec "$CONTAINER" kafka-topics --bootstrap-server "$BROKER" --list | grep '^match\.'
