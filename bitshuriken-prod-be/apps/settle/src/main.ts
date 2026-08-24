import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { SettleAppModule } from './settle-app.module';
import { matchPartitionCount } from '@app/shared/partition';

/**
 * settle 프로세스 (M1): 정산·컨슈머 기계장치를 API 이벤트루프 밖에서 구동.
 * - Kafka 그룹 `bitshuriken-settle` — match.{spot,futures}.out의 DB 효과
 *   (API 앱들의 기존 그룹은 경량 인메모리 효과만, 독립 오프셋)
 * - 양 정산 워커 + DLQ + 원장 프로젝터/드리프트 + 읽기 레플리카 (저널 테일)
 * - HTTP는 헬스 전용 (:PORT_SETTLE) — exchange.sh 검증·B5 헬스체크 표면
 */
async function bootstrap() {
  const port = process.env.PORT_SETTLE;
  if (!port) throw new Error('PORT_SETTLE is required');
  const broker = process.env.KAFKA_BROKER;
  if (!broker) throw new Error('KAFKA_BROKER is required');

  const app = await NestFactory.create(SettleAppModule);
  app.enableShutdownHooks(); // F0 — 컨슈머 정지·워커 quiesce·disconnect 시퀀스

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: { clientId: 'bitshuriken-settle', brokers: [broker] },
      consumer: { groupId: 'bitshuriken-settle' },
      run: {
        partitionsConsumedConcurrently: Math.max(
          matchPartitionCount('SPOT'),
          matchPartitionCount('FUTURES'),
        ),
      },
    },
  });

  await app.startAllMicroservices();
  await app.listen(port);
}

void bootstrap();
