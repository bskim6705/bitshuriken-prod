import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Kafka, Producer } from 'kafkajs';

@Injectable()
export class KafkaService implements OnModuleInit, OnModuleDestroy {
  private kafka: Kafka;
  private producer: Producer;

  constructor() {
    const broker = process.env.KAFKA_BROKER;
    if (!broker) throw new Error('KAFKA_BROKER is required');

    this.kafka = new Kafka({
      clientId: 'bitshuriken-be',
      brokers: [broker],
    });
    this.producer = this.kafka.producer();
  }

  async onModuleInit() {
    await this.producer.connect();
  }

  async onModuleDestroy() {
    await this.producer.disconnect();
  }

  // key=symbol — 매칭엔진이 message key로 lane을 라우팅한다(여러 symbol이 한 partition 버킷 공유).
  async emit(topic: string, partition: number, message: unknown, key?: string): Promise<void> {
    await this.producer.send({
      topic,
      messages: [{ partition, key, value: JSON.stringify(message) }],
    });
  }
}
