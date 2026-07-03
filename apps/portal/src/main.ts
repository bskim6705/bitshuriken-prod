import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { PortalAppModule } from './portal-app.module';
import { applyGlobalPipeline } from '@app/shared/bootstrap/apply-global-pipeline';
import { PORTAL_API_DESCRIPTION } from '@app/shared/docs/api-description';

// REST 전용 앱 — Kafka consumer/WS 게이트웨이 없음.
async function bootstrap() {
  const port = process.env.PORT_PORTAL;
  if (!port) throw new Error('PORT_PORTAL is required');

  // rawBody: API key signature 검증 시 원본 body bytes 필요.
  const app = await NestFactory.create(PortalAppModule, { rawBody: true });
  applyGlobalPipeline(app);

  const config = new DocumentBuilder()
    .setTitle('Bitshuriken Portal API')
    .setVersion('0.1')
    .setDescription(PORTAL_API_DESCRIPTION)
    .addServer('http://localhost:5103', 'portal (dev)')
    .addCookieAuth('bs_session', { type: 'apiKey', in: 'cookie', name: 'bs_session' }, 'cookieAuth')
    .addApiKey(
      {
        type: 'apiKey',
        name: 'X-API-Key',
        in: 'header',
        description:
          'API key; signed requests also send the HMAC-SHA256 signature header per ADR-019',
      },
      'apiKey',
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs-json' });

  await app.listen(port);
}
void bootstrap();
