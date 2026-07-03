import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { App } from 'supertest/types';
import { PortalAppModule } from '../apps/portal/src/portal-app.module';
import { AppModule } from '../apps/spot/src/app.module';
import { ResponseInterceptor } from '@app/shared/interceptors/response.interceptor';
import { HttpExceptionFilter } from '@app/shared/filters/http-exception.filter';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { KafkaService } from '@app/infra/messaging/kafka.service';
import { ApiResponse } from '@app/shared/interfaces/api-response';
import { signup, sign, IssuedApiKey } from './helpers/auth';

interface ApiKeyListItem {
  id: string;
  apiKey: string;
  label: string | null;
  canTrade: boolean;
  canRead: boolean;
  ipWhitelist: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

describe('API key (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const testEmail = `apikey-${Date.now()}@test.com`;
  let jwtToken: string;
  let userId: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PortalAppModule, AppModule],
    })
      // KafkaService를 mock — 실제 broker connect 회피
      .overrideProvider(KafkaService)
      .useValue({
        emit: jest.fn(),
        onModuleInit: jest.fn(),
        onModuleDestroy: jest.fn(),
      })
      .compile();

    // rawBody: true — main.ts와 동일. signature 검증 시 raw body 필요.
    app = moduleFixture.createNestApplication({ rawBody: true });
    app.useWebSocketAdapter(new WsAdapter(app));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);

    const auth = await signup(app, testEmail);
    jwtToken = auth.accessToken;
    userId = auth.userId;
  });

  afterAll(async () => {
    await prisma.apiKey.deleteMany({ where: { userId } });
    await prisma.authToken.deleteMany({ where: { userId } }); // signup creates an email-verify token (FK)
    await prisma.user.deleteMany({ where: { email: testEmail } });
    await app.close();
  });

  describe('POST /auth/api-keys', () => {
    it('should issue an API key with secret in response (1회만)', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/api-keys')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({ label: 'test bot', canTrade: true, canRead: true })
        .expect(201);

      const body = res.body as ApiResponse<IssuedApiKey>;
      expect(body.code).toBe(0);
      expect(body.data?.apiKey).toBeDefined();
      expect(body.data?.secret).toBeDefined();
      expect(body.data?.canTrade).toBe(true);
      expect(body.data?.canRead).toBe(true);
      expect(body.data?.label).toBe('test bot');
    });

    it('should reject without JWT (PrivateGuard 거부 — 이 endpoint는 JwtOnly)', async () => {
      await request(app.getHttpServer())
        .post('/auth/api-keys')
        .send({ label: 'no auth' })
        .expect(401);
    });

    it('should reject when authenticated via API key (escalation 차단)', async () => {
      // 먼저 JWT로 키를 하나 발급받는다
      const issueRes = await request(app.getHttpServer())
        .post('/auth/api-keys')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({})
        .expect(201);
      const issued = (issueRes.body as ApiResponse<IssuedApiKey>).data!;

      // API key로 새 키 발급 시도 → JwtOnlyGuard가 거부
      const ts = Date.now();
      const qs = `timestamp=${ts}`;
      const sig = sign(issued.secret, qs);
      await request(app.getHttpServer())
        .post(`/auth/api-keys?${qs}&signature=${sig}`)
        .set('X-API-KEY', issued.apiKey)
        .send({})
        .expect(401);
    });
  });

  describe('GET /auth/api-keys', () => {
    it('should list keys without secret', async () => {
      const res = await request(app.getHttpServer())
        .get('/auth/api-keys')
        .set('Authorization', `Bearer ${jwtToken}`)
        .expect(200);

      const body = res.body as ApiResponse<ApiKeyListItem[]>;
      expect(body.code).toBe(0);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data!.length).toBeGreaterThan(0);
      // secret 필드는 응답에 없어야 함
      for (const item of body.data!) {
        expect((item as unknown as { secret?: string }).secret).toBeUndefined();
      }
    });
  });

  describe('DELETE /auth/api-keys/:id', () => {
    it('should revoke a key (soft delete) and remove from list', async () => {
      // 새 키 발급
      const issueRes = await request(app.getHttpServer())
        .post('/auth/api-keys')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({ label: 'to be revoked' })
        .expect(201);
      const issued = (issueRes.body as ApiResponse<IssuedApiKey>).data!;

      // revoke
      await request(app.getHttpServer())
        .delete(`/auth/api-keys/${issued.id}`)
        .set('Authorization', `Bearer ${jwtToken}`)
        .expect(204);

      // 목록에서 사라져야 함
      const listRes = await request(app.getHttpServer())
        .get('/auth/api-keys')
        .set('Authorization', `Bearer ${jwtToken}`)
        .expect(200);
      const list = (listRes.body as ApiResponse<ApiKeyListItem[]>).data!;
      expect(list.find((k) => k.id === issued.id)).toBeUndefined();

      // revoked 키로 protected endpoint 호출 → 401
      const ts = Date.now();
      const qs = `timestamp=${ts}`;
      const sig = sign(issued.secret, qs);
      await request(app.getHttpServer())
        .get(`/spot/account/balances?${qs}&signature=${sig}`)
        .set('X-API-KEY', issued.apiKey)
        .expect(401);
    });

    it('should be idempotent (두 번 revoke 해도 OK)', async () => {
      const issueRes = await request(app.getHttpServer())
        .post('/auth/api-keys')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({})
        .expect(201);
      const issued = (issueRes.body as ApiResponse<IssuedApiKey>).data!;

      await request(app.getHttpServer())
        .delete(`/auth/api-keys/${issued.id}`)
        .set('Authorization', `Bearer ${jwtToken}`)
        .expect(204);
      // 두 번째: 이미 revoked인데 200/204
      await request(app.getHttpServer())
        .delete(`/auth/api-keys/${issued.id}`)
        .set('Authorization', `Bearer ${jwtToken}`)
        .expect(204);
    });
  });

  describe('PrivateGuard with API key (positive)', () => {
    let apiKey: string;
    let secret: string;

    beforeAll(async () => {
      const issueRes = await request(app.getHttpServer())
        .post('/auth/api-keys')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({ label: 'guard test', canTrade: true })
        .expect(201);
      const issued = (issueRes.body as ApiResponse<IssuedApiKey>).data!;
      apiKey = issued.apiKey;
      secret = issued.secret;
    });

    it('GET /spot/account/balances (no body, query only)', async () => {
      const ts = Date.now();
      const qs = `timestamp=${ts}`;
      const sig = sign(secret, qs);

      await request(app.getHttpServer())
        .get(`/spot/account/balances?${qs}&signature=${sig}`)
        .set('X-API-KEY', apiKey)
        .expect(200);
    });

    it('GET /spot/account/orders with extra query params (signature includes them)', async () => {
      const ts = Date.now();
      // open=true도 canonical에 포함. signature 계산 시 같은 순서/문자열 사용.
      const qs = `open=true&timestamp=${ts}`;
      const sig = sign(secret, qs);

      await request(app.getHttpServer())
        .get(`/spot/account/orders?${qs}&signature=${sig}`)
        .set('X-API-KEY', apiKey)
        .expect(200);
    });
  });

  describe('PrivateGuard with API key (negative)', () => {
    let apiKey: string;
    let secret: string;

    beforeAll(async () => {
      const issueRes = await request(app.getHttpServer())
        .post('/auth/api-keys')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({})
        .expect(201);
      const issued = (issueRes.body as ApiResponse<IssuedApiKey>).data!;
      apiKey = issued.apiKey;
      secret = issued.secret;
    });

    it('reject wrong signature', async () => {
      const ts = Date.now();
      const qs = `timestamp=${ts}`;
      const sig = sign('wrong-secret', qs);

      await request(app.getHttpServer())
        .get(`/spot/account/balances?${qs}&signature=${sig}`)
        .set('X-API-KEY', apiKey)
        .expect(401);
    });

    it('reject missing signature', async () => {
      const ts = Date.now();
      await request(app.getHttpServer())
        .get(`/spot/account/balances?timestamp=${ts}`)
        .set('X-API-KEY', apiKey)
        .expect(400);
    });

    it('reject missing timestamp', async () => {
      const sig = sign(secret, '');
      await request(app.getHttpServer())
        .get(`/spot/account/balances?signature=${sig}`)
        .set('X-API-KEY', apiKey)
        .expect(400);
    });

    it('reject timestamp outside recvWindow', async () => {
      const ts = Date.now() - 60_000; // 60s 전
      const qs = `timestamp=${ts}`;
      const sig = sign(secret, qs);

      await request(app.getHttpServer())
        .get(`/spot/account/balances?${qs}&signature=${sig}`)
        .set('X-API-KEY', apiKey)
        .expect(401);
    });

    it('reject unknown api key', async () => {
      const ts = Date.now();
      const qs = `timestamp=${ts}`;
      const sig = sign(secret, qs);

      await request(app.getHttpServer())
        .get(`/spot/account/balances?${qs}&signature=${sig}`)
        .set('X-API-KEY', 'no-such-key')
        .expect(401);
    });

    it('reject when neither JWT nor X-API-KEY present', async () => {
      await request(app.getHttpServer()).get(`/spot/account/balances`).expect(401);
    });
  });
});
