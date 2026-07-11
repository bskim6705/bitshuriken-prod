import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../apps/spot/src/app.module';
import { PortalAppModule } from '../apps/portal/src/portal-app.module';
import { ResponseInterceptor } from '@app/shared/interceptors/response.interceptor';
import { HttpExceptionFilter } from '@app/shared/filters/http-exception.filter';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { KafkaService } from '@app/infra/messaging/kafka.service';
import { ApiResponse } from '@app/shared/interfaces/api-response';
import { signup, issueApiKey, sign, IssuedApiKey } from './helpers/auth';

interface OrderRow {
  id: string;
  userId: string;
  tickerSymbol: string;
  tickerMarket: 'SPOT' | 'FUTURES';
  type: 'LIMIT' | 'MARKET' | 'POST_ONLY';
  side: 'BUY' | 'SELL';
  timeInForce: 'GTC' | 'IOC' | 'FOK';
  price: string | null;
  origQty: string | null;
  origQuoteQty: string | null;
  status: string;
}

// 격리된 테스트 자산. seed와 충돌 방지.
const TEST_BASE = 'TESTBASE';
const TEST_QUOTE = 'TESTQUOTE';
const TEST_SYMBOL = 'TESTBASETESTQUOTE';
const TEST_MARKET = 'SPOT';
const TEST_PARTITION = 999;

describe('Trading (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let kafkaEmit: jest.Mock;

  // 두 명의 user, 같은 ticker 사용
  const aliceEmail = `alice-trade-${Date.now()}@test.com`;
  const bobEmail = `bob-trade-${Date.now()}@test.com`;
  let aliceJwt: string;
  let aliceId: string;
  let bobJwt: string;
  let bobId: string;
  let aliceApiKey: IssuedApiKey;

  beforeAll(async () => {
    kafkaEmit = jest.fn();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule, PortalAppModule],
    })
      .overrideProvider(KafkaService)
      .useValue({
        emit: kafkaEmit,
        onModuleInit: jest.fn(),
        onModuleDestroy: jest.fn(),
      })
      .compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.useWebSocketAdapter(new WsAdapter(app));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);

    // 1. 격리된 asset/ticker seed
    await prisma.asset.upsert({
      where: { symbol: TEST_BASE },
      create: { symbol: TEST_BASE, name: 'Test Base', precision: 8, type: 'CRYPTO' },
      update: {},
    });
    await prisma.asset.upsert({
      where: { symbol: TEST_QUOTE },
      create: { symbol: TEST_QUOTE, name: 'Test Quote', precision: 8, type: 'STABLECOIN' },
      update: {},
    });
    await prisma.ticker.upsert({
      where: {
        symbol_marketType: { symbol: TEST_SYMBOL, marketType: TEST_MARKET },
      },
      create: {
        symbol: TEST_SYMBOL,
        marketType: TEST_MARKET,
        baseAssetSymbol: TEST_BASE,
        quoteAssetSymbol: TEST_QUOTE,
        pricePrecision: 2,
        qtyPrecision: 5,
        partition: TEST_PARTITION,
      },
      update: {},
    });

    // 2. 두 user signup → JWT
    const alice = await signup(app, aliceEmail);
    aliceJwt = alice.accessToken;
    aliceId = alice.userId;
    const bob = await signup(app, bobEmail);
    bobJwt = bob.accessToken;
    bobId = bob.userId;

    // 3. 각 user에게 wallet seed
    //    alice는 quote 100,000 (BUY 잠금용)
    //    bob은 base 1 (SELL 잠금용)
    await prisma.wallet.create({
      data: {
        userId: aliceId,
        assetSymbol: TEST_QUOTE,
        marketType: TEST_MARKET,
        balance: '100000',
      },
    });
    await prisma.wallet.create({
      data: {
        userId: bobId,
        assetSymbol: TEST_BASE,
        marketType: TEST_MARKET,
        balance: '1',
      },
    });

    // 4. alice에게 API key 발급 (canTrade)
    aliceApiKey = await issueApiKey(app, aliceJwt, {
      label: 'alice trading bot',
      canTrade: true,
    });
  });

  afterAll(async () => {
    await prisma.order.deleteMany({
      where: { userId: { in: [aliceId, bobId] } },
    });
    await prisma.apiKey.deleteMany({
      where: { userId: { in: [aliceId, bobId] } },
    });
    await prisma.wallet.deleteMany({
      where: { userId: { in: [aliceId, bobId] } },
    });
    await prisma.authToken.deleteMany({
      where: { userId: { in: [aliceId, bobId] } },
    }); // signup creates an email-verify token (FK)
    await prisma.session.deleteMany({
      where: { userId: { in: [aliceId, bobId] } },
    });
    await prisma.loginHistory.deleteMany({
      where: { userId: { in: [aliceId, bobId] } },
    });
    await prisma.user.deleteMany({
      where: { email: { in: [aliceEmail, bobEmail] } },
    });
    // ticker/asset은 다른 테스트가 재사용할 수 있으니 그대로 둠 (upsert로 idempotent)
    await app.close();
  });

  beforeEach(() => {
    kafkaEmit.mockClear();
  });

  // ----------------------------------------------------------
  // POST /spot/trading/orders — JWT 경로
  // ----------------------------------------------------------
  describe('POST /spot/trading/orders (JWT)', () => {
    it('LIMIT BUY: locks quote balance and emits to Kafka', async () => {
      const before = await prisma.wallet.findUnique({
        where: {
          userId_assetSymbol_marketType: {
            userId: aliceId,
            assetSymbol: TEST_QUOTE,
            marketType: TEST_MARKET,
          },
        },
      });

      const res = await request(app.getHttpServer())
        .post('/spot/trading/orders')
        .set('Authorization', `Bearer ${aliceJwt}`)
        .send({
          tickerSymbol: TEST_SYMBOL,
          tickerMarket: TEST_MARKET,
          type: 'LIMIT',
          side: 'BUY',
          timeInForce: 'GTC',
          price: '50000',
          origQty: '0.5',
        })
        .expect(201);

      const body = res.body as ApiResponse<OrderRow>;
      expect(body.code).toBe(0);
      expect(body.data?.userId).toBe(aliceId);
      expect(body.data?.status).toBe('NEW');

      // wallet: balance -= 25000, locked += 25000
      const after = await prisma.wallet.findUnique({
        where: {
          userId_assetSymbol_marketType: {
            userId: aliceId,
            assetSymbol: TEST_QUOTE,
            marketType: TEST_MARKET,
          },
        },
      });
      expect(Number(after!.balance) - Number(before!.balance)).toBeCloseTo(-25000);
      expect(Number(after!.locked) - Number(before!.locked)).toBeCloseTo(25000);

      // Kafka emit 호출 확인
      expect(kafkaEmit).toHaveBeenCalledTimes(1);
      const [topic, partition, message] = kafkaEmit.mock.calls[0] as [
        string,
        number,
        Record<string, unknown>,
      ];
      expect(topic).toBe('match.spot.in');
      expect(partition).toBe(TEST_PARTITION);
      expect(message.op).toBe('NO');
      expect(message.s).toBe(TEST_SYMBOL);
    });

    it('LIMIT SELL: locks base balance', async () => {
      const before = await prisma.wallet.findUnique({
        where: {
          userId_assetSymbol_marketType: {
            userId: bobId,
            assetSymbol: TEST_BASE,
            marketType: TEST_MARKET,
          },
        },
      });

      await request(app.getHttpServer())
        .post('/spot/trading/orders')
        .set('Authorization', `Bearer ${bobJwt}`)
        .send({
          tickerSymbol: TEST_SYMBOL,
          tickerMarket: TEST_MARKET,
          type: 'LIMIT',
          side: 'SELL',
          timeInForce: 'GTC',
          price: '50000',
          origQty: '0.1',
        })
        .expect(201);

      const after = await prisma.wallet.findUnique({
        where: {
          userId_assetSymbol_marketType: {
            userId: bobId,
            assetSymbol: TEST_BASE,
            marketType: TEST_MARKET,
          },
        },
      });
      expect(Number(after!.balance) - Number(before!.balance)).toBeCloseTo(-0.1);
      expect(Number(after!.locked) - Number(before!.locked)).toBeCloseTo(0.1);
    });

    it('MARKET BUY: locks origQuoteQty', async () => {
      const before = await prisma.wallet.findUnique({
        where: {
          userId_assetSymbol_marketType: {
            userId: aliceId,
            assetSymbol: TEST_QUOTE,
            marketType: TEST_MARKET,
          },
        },
      });

      await request(app.getHttpServer())
        .post('/spot/trading/orders')
        .set('Authorization', `Bearer ${aliceJwt}`)
        .send({
          tickerSymbol: TEST_SYMBOL,
          tickerMarket: TEST_MARKET,
          type: 'MARKET',
          side: 'BUY',
          timeInForce: 'IOC',
          origQuoteQty: '100',
        })
        .expect(201);

      const after = await prisma.wallet.findUnique({
        where: {
          userId_assetSymbol_marketType: {
            userId: aliceId,
            assetSymbol: TEST_QUOTE,
            marketType: TEST_MARKET,
          },
        },
      });
      expect(Number(after!.balance) - Number(before!.balance)).toBeCloseTo(-100);
      expect(Number(after!.locked) - Number(before!.locked)).toBeCloseTo(100);
    });

    it('rejects when balance insufficient', async () => {
      await request(app.getHttpServer())
        .post('/spot/trading/orders')
        .set('Authorization', `Bearer ${aliceJwt}`)
        .send({
          tickerSymbol: TEST_SYMBOL,
          tickerMarket: TEST_MARKET,
          type: 'LIMIT',
          side: 'BUY',
          timeInForce: 'GTC',
          price: '99999999',
          origQty: '99999999',
        })
        .expect(400);
    });

    it('rejects unknown ticker', async () => {
      await request(app.getHttpServer())
        .post('/spot/trading/orders')
        .set('Authorization', `Bearer ${aliceJwt}`)
        .send({
          tickerSymbol: 'NOPE',
          tickerMarket: TEST_MARKET,
          type: 'LIMIT',
          side: 'BUY',
          timeInForce: 'GTC',
          price: '1',
          origQty: '1',
        })
        .expect(404);
    });

    it('rejects without auth', async () => {
      await request(app.getHttpServer())
        .post('/spot/trading/orders')
        .send({
          tickerSymbol: TEST_SYMBOL,
          tickerMarket: TEST_MARKET,
          type: 'LIMIT',
          side: 'BUY',
          timeInForce: 'GTC',
          price: '50000',
          origQty: '0.5',
        })
        .expect(401);
    });
  });

  // ----------------------------------------------------------
  // DTO validation
  // ----------------------------------------------------------
  describe('DTO validation', () => {
    const post = (body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post('/spot/trading/orders')
        .set('Authorization', `Bearer ${aliceJwt}`)
        .send(body);

    it('LIMIT requires price and origQty', async () => {
      await post({
        tickerSymbol: TEST_SYMBOL,
        tickerMarket: TEST_MARKET,
        type: 'LIMIT',
        side: 'BUY',
        timeInForce: 'GTC',
        // price/origQty 없음
      }).expect(400);
    });

    it('LIMIT must not have origQuoteQty', async () => {
      await post({
        tickerSymbol: TEST_SYMBOL,
        tickerMarket: TEST_MARKET,
        type: 'LIMIT',
        side: 'BUY',
        timeInForce: 'GTC',
        price: '50000',
        origQty: '0.1',
        origQuoteQty: '5000', // 잘못됨
      }).expect(400);
    });

    it('MARKET BUY requires origQuoteQty', async () => {
      await post({
        tickerSymbol: TEST_SYMBOL,
        tickerMarket: TEST_MARKET,
        type: 'MARKET',
        side: 'BUY',
        timeInForce: 'IOC',
        origQty: '0.1', // 잘못됨: BUY는 quote
      }).expect(400);
    });

    it('MARKET SELL requires origQty', async () => {
      await post({
        tickerSymbol: TEST_SYMBOL,
        tickerMarket: TEST_MARKET,
        type: 'MARKET',
        side: 'SELL',
        timeInForce: 'IOC',
        origQuoteQty: '5000', // 잘못됨: SELL은 base
      }).expect(400);
    });

    it('MARKET must not have price', async () => {
      await post({
        tickerSymbol: TEST_SYMBOL,
        tickerMarket: TEST_MARKET,
        type: 'MARKET',
        side: 'BUY',
        timeInForce: 'IOC',
        price: '50000',
        origQuoteQty: '5000',
      }).expect(400);
    });
  });

  // ----------------------------------------------------------
  // DELETE /spot/trading/orders/:id
  // ----------------------------------------------------------
  describe('DELETE /spot/trading/orders/:id', () => {
    it('owner can cancel; emits CO to Kafka', async () => {
      // 새 주문
      const createRes = await request(app.getHttpServer())
        .post('/spot/trading/orders')
        .set('Authorization', `Bearer ${aliceJwt}`)
        .send({
          tickerSymbol: TEST_SYMBOL,
          tickerMarket: TEST_MARKET,
          type: 'LIMIT',
          side: 'BUY',
          timeInForce: 'GTC',
          price: '40000',
          origQty: '0.1',
        })
        .expect(201);
      const order = (createRes.body as ApiResponse<OrderRow>).data!;
      kafkaEmit.mockClear();

      await request(app.getHttpServer())
        .delete(`/spot/trading/orders/${order.id}`)
        .set('Authorization', `Bearer ${aliceJwt}`)
        .expect(200);

      // CO emit 검증
      expect(kafkaEmit).toHaveBeenCalledTimes(1);
      const message = (kafkaEmit.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
      expect(message.op).toBe('CO');
      expect(message.id).toBe(order.id);
    });

    it('rejects cancel of another user order (403)', async () => {
      // bob이 주문 생성
      const createRes = await request(app.getHttpServer())
        .post('/spot/trading/orders')
        .set('Authorization', `Bearer ${bobJwt}`)
        .send({
          tickerSymbol: TEST_SYMBOL,
          tickerMarket: TEST_MARKET,
          type: 'LIMIT',
          side: 'SELL',
          timeInForce: 'GTC',
          price: '60000',
          origQty: '0.05',
        })
        .expect(201);
      const order = (createRes.body as ApiResponse<OrderRow>).data!;

      // alice가 cancel 시도
      await request(app.getHttpServer())
        .delete(`/spot/trading/orders/${order.id}`)
        .set('Authorization', `Bearer ${aliceJwt}`)
        .expect(403);
    });

    it('returns 404 for unknown order', async () => {
      await request(app.getHttpServer())
        .delete('/spot/trading/orders/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${aliceJwt}`)
        .expect(404);
    });
  });

  // ----------------------------------------------------------
  // POST /spot/trading/orders — API key 경로 (signature 검증 + body)
  // ----------------------------------------------------------
  describe('POST /spot/trading/orders (API key + signature)', () => {
    it('signs query + body and passes PrivateGuard', async () => {
      const ts = Date.now();
      const qs = `timestamp=${ts}`;
      const bodyObj = {
        tickerSymbol: TEST_SYMBOL,
        tickerMarket: TEST_MARKET,
        type: 'LIMIT',
        side: 'BUY',
        timeInForce: 'GTC',
        price: '30000',
        origQty: '0.01',
      };
      const bodyStr = JSON.stringify(bodyObj);
      const sig = sign(aliceApiKey.secret, qs, bodyStr);

      await request(app.getHttpServer())
        .post(`/spot/trading/orders?${qs}&signature=${sig}`)
        .set('X-API-KEY', aliceApiKey.apiKey)
        .set('Content-Type', 'application/json')
        .send(bodyStr) // raw string으로 전송 — express raw body가 같은 bytes를 봄
        .expect(201);
    });

    it('rejects when body is tampered after signing', async () => {
      const ts = Date.now();
      const qs = `timestamp=${ts}`;
      const original = {
        tickerSymbol: TEST_SYMBOL,
        tickerMarket: TEST_MARKET,
        type: 'LIMIT',
        side: 'BUY',
        timeInForce: 'GTC',
        price: '30000',
        origQty: '0.01',
      };
      const sig = sign(aliceApiKey.secret, qs, JSON.stringify(original));
      // 서버로 보낼 때는 다른 body
      const tampered = { ...original, origQty: '99' };

      await request(app.getHttpServer())
        .post(`/spot/trading/orders?${qs}&signature=${sig}`)
        .set('X-API-KEY', aliceApiKey.apiKey)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(tampered))
        .expect(401);
    });
  });
});
