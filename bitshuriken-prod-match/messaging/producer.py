import orjson
from confluent_kafka import KafkaError, Message, Producer


class KafkaProducerWrapper:
    def __init__(self, broker: str) -> None:
        self.producer = Producer({"bootstrap.servers": broker})

    def emit(self, topic: str, partition: int, message: dict, key: str | None = None) -> None:
        # orjson.dumps -> bytes (str 인코딩 단계 생략, json 대비 ~5~10x).
        self.producer.produce(topic, key=key, value=orjson.dumps(message), partition=partition)
        self.producer.poll(0)

    def emit_keyed(self, topic: str, partition: int, key: str, message: dict) -> None:
        """key 있는 발행 — log-compacted state topic용. 전달 실패는 조용히 버리지 않는다."""
        self.producer.produce(
            topic,
            key=key,
            value=orjson.dumps(message),
            partition=partition,
            on_delivery=self._log_delivery_error,
        )
        self.producer.poll(0)

    @staticmethod
    def _log_delivery_error(err: KafkaError | None, msg: Message) -> None:
        if err is not None:
            print(f"state publish delivery failed: {msg.topic()}[{msg.partition()}] {err}")

    def flush(self) -> None:
        self.producer.flush()
