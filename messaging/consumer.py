from confluent_kafka import Consumer, Message, TopicPartition


class KafkaConsumerWrapper:
    """수동 partition assign 방식. 오프셋의 유일한 출처는 스냅샷 — 항상 명시 offset으로 assign."""

    def __init__(self, broker: str, group_id: str) -> None:
        self.consumer = Consumer(
            {
                "bootstrap.servers": broker,
                "group.id": group_id,
                "enable.auto.commit": False,
            }
        )

    def assign(self, assignments: list[tuple[str, int, int]]) -> None:
        """[(topic, partition, offset), ...] 형태로 명시 할당. 기존 할당을 교체한다."""
        self.consumer.assign(
            [TopicPartition(topic, partition, offset) for topic, partition, offset in assignments]
        )

    def watermarks(self, topic: str, partition: int) -> tuple[int, int]:
        """(low, high) 오프셋 조회."""
        return self.consumer.get_watermark_offsets(TopicPartition(topic, partition), 10.0)

    def poll(self, timeout: float = 1.0) -> Message | None:
        return self.consumer.poll(timeout)

    def close(self) -> None:
        self.consumer.close()
