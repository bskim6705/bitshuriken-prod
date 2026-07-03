import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { applyGlobalPipeline } from '@app/shared/bootstrap/apply-global-pipeline';
import { SPOT_API_DESCRIPTION } from '@app/shared/docs/api-description';

async function bootstrap() {
  const port = process.env.PORT_SPOT;
  if (!port) throw new Error('PORT_SPOT is required');
  const broker = process.env.KAFKA_BROKER;
  if (!broker) throw new Error('KAFKA_BROKER is required');

  // rawBody: API key signature 검증 시 원본 body bytes 필요.
  const app = await NestFactory.create(AppModule, { rawBody: true });
  applyGlobalPipeline(app);
  app.useWebSocketAdapter(new WsAdapter(app));

  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.KAFKA,
    options: {
      client: {
        clientId: 'bitshuriken-be-spot',
        brokers: [broker],
      },
      consumer: {
        groupId: 'bitshuriken-be-spot',
      },
    },
  });

  const config = new DocumentBuilder()
    .setTitle('Bitshuriken Spot API')
    .setVersion('0.1')
    .setDescription(SPOT_API_DESCRIPTION)
    .addServer('http://localhost:5101', 'spot (dev)')
    .addCookieAuth('bs_session', { type: 'apiKey', in: 'cookie', name: 'bs_session' }, 'cookieAuth')
    .addApiKey(
      {
        type: 'apiKey',
        name: 'X-API-Key',
        in: 'header',
        description:
          'API key; signed requests also send the HMAC-SHA256 signature (timestamp + signature query params over query string + raw body)',
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
