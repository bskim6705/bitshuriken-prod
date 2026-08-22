import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { FuturesAppModule } from './futures-app.module';
import { applyGlobalPipeline } from '@app/shared/bootstrap/apply-global-pipeline';
import { FUTURES_API_DESCRIPTION } from '@app/shared/docs/api-description';
import { matchPartitionCount } from '@app/shared/partition';

async function bootstrap() {
  const port = process.env.PORT_FUTURES;
  if (!port) throw new Error('PORT_FUTURES is required');
  const broker = process.env.KAFKA_BROKER;
  if (!broker) throw new Error('KAFKA_BROKER is required');

  // rawBody: API key signature 검증 시 원본 body bytes 필요.
  const app = await NestFactory.create(FuturesAppModule, { rawBody: true });
  applyGlobalPipeline(app);
  app.useWebSocketAdapter(new WsAdapter(app));

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: 'bitshuriken-be-futures',
        brokers: [broker],
      },
      consumer: {
        groupId: 'bitshuriken-be-futures',
      },
      // 심볼→파티션 고정이라 파티션 간 공유 행 없음(Position/Order/Trade 쓰기는 모두 심볼 단위,
      // 포지션 적용은 별도 정산 worker) → 파티션 병렬 소비로 직렬(=1) 소비 상한 해제.
      run: {
        partitionsConsumedConcurrently: matchPartitionCount('FUTURES'),
      },
    },
  });

  const config = new DocumentBuilder()
    .setTitle('Bitshuriken Futures API')
    .setVersion('0.1')
    .setDescription(FUTURES_API_DESCRIPTION)
    .addServer(`http://localhost:${port}`, 'futures (dev)')
    .addCookieAuth('bs_session', { type: 'apiKey', in: 'cookie', name: 'bs_session' }, 'cookieAuth')
    .addApiKey(
      {
        type: 'apiKey',
        name: 'X-API-Key',
        in: 'header',
        description:
          'API key; signed requests also send the HMAC-SHA256 signature header per the API-key signature spec',
      },
      'apiKey',
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs-json' });

  await app.startAllMicroservices();
  await app.listen(port);
}
void bootstrap();
