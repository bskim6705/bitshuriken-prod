import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PortalAppModule } from '../apps/portal/src/portal-app.module';
import { ResponseInterceptor } from '@app/shared/interceptors/response.interceptor';
import { HttpExceptionFilter } from '@app/shared/filters/http-exception.filter';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { ApiResponse } from '@app/shared/interfaces/api-response';
import { extractSessionToken } from './helpers/auth';

interface UserProfile {
  id: string;
  email: string;
  createdAt: string;
}

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const testEmail = `test-${Date.now()}@test.com`;
  const password = 'password123';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PortalAppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    // delete child rows first (AuthToken FK -> User) before removing the user
    await prisma.authToken.deleteMany({ where: { user: { email: testEmail } } });
    await prisma.user.deleteMany({ where: { email: testEmail } });
    await app.close();
  });

  describe('POST /auth/signup', () => {
    it('should create a user and return token', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/signup')
        .send({ email: testEmail, password })
        .expect(201);

      const body = res.body as ApiResponse<UserProfile>;
      expect(body.code).toBe(0);
      expect(body.message).toBe('ok');
      expect(body.data?.id).toBeDefined();
      expect(body.data?.email).toBe(testEmail);
      expect(extractSessionToken(res.headers['set-cookie'])).toBeTruthy();
    });

    it('should reject duplicate email', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/signup')
        .send({ email: testEmail, password })
        .expect(409);

      const body = res.body as ApiResponse<UserProfile>;
      expect(body.code).not.toBe(0);
      expect(body.data).toBeNull();
    });

    it('should reject invalid email', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/signup')
        .send({ email: 'not-an-email', password })
        .expect(400);

      const body = res.body as ApiResponse<UserProfile>;
      expect(body.code).not.toBe(0);
    });

    it('should reject short password', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/signup')
        .send({ email: `short-${Date.now()}@test.com`, password: 'short' })
        .expect(400);

      const body = res.body as ApiResponse<UserProfile>;
      expect(body.code).not.toBe(0);
    });
  });

  describe('POST /auth/login', () => {
    it('should login with correct credentials', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: testEmail, password })
        .expect(201);

      const body = res.body as ApiResponse<UserProfile>;
      expect(body.code).toBe(0);
      expect(body.data?.id).toBeDefined();
      expect(extractSessionToken(res.headers['set-cookie'])).toBeTruthy();
    });

    it('should reject wrong password', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: testEmail, password: 'wrong-password' })
        .expect(401);

      const body = res.body as ApiResponse<UserProfile>;
      expect(body.code).not.toBe(0);
    });

    it('should reject non-existent user', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'no-such-user@test.com', password })
        .expect(401);

      const body = res.body as ApiResponse<UserProfile>;
      expect(body.code).not.toBe(0);
    });
  });
});
