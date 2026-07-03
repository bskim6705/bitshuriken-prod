import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import request from 'supertest';
import { App } from 'supertest/types';
import { AssetType, MarketType } from '@prisma/client';
import { PortalAppModule } from '../apps/portal/src/portal-app.module';
import { AppModule } from '../apps/spot/src/app.module';
import { ResponseInterceptor } from '@app/shared/interceptors/response.interceptor';
import { HttpExceptionFilter } from '@app/shared/filters/http-exception.filter';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { KafkaService } from '@app/infra/messaging/kafka.service';
import { ApiResponse } from '@app/shared/interfaces/api-response';
import { signup, issueApiKey, sign } from './helpers/auth';

interface Subaccount {
  id: string;
  label: string | null;
  feeMakerBps: number;
  feeTakerBps: number;
  createdAt: string;
}
interface IssuedKey {
  id: string;
  apiKey: string;
  secret: string;
  canTrade: boolean;
  canRead: boolean;
}
interface SubBalance {
  assetSymbol: string;
  marketType: string;
  balance: string;
  locked: string;
}
interface WalletRow {
  assetSymbol: string;
  marketType: string;
  balance: string;
}
interface TxRow {
  id: string;
  type: string;
  assetSymbol: string;
  qty: string;
  fromMarket: string | null;
  toMarket: string | null;
  counterpartyUserId: string | null;
}

const STAMP = Date.now();

describe('Subaccount (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let server: App;

  const masterEmail = `sub-master-${STAMP}@test.com`;
  const otherEmail = `sub-other-${STAMP}@test.com`;
  let masterJwt: string;
  let masterId: string;
  let otherJwt: string;
  let otherId: string;
  let otherSubId: string;

  const createSub = async (label?: string): Promise<Subaccount> => {
    const res = await request(server)
      .post('/subaccounts')
      .set('Authorization', `Bearer ${masterJwt}`)
      .send(label ? { label } : {})
      .expect(201);
    return (res.body as ApiResponse<Subaccount>).data!;
  };

  const issueSubKey = async (
    subId: string,
    params: { canTrade?: boolean; canRead?: boolean; label?: string } = {},
  ): Promise<IssuedKey> => {
    const res = await request(server)
      .post(`/subaccounts/${subId}/api-keys`)
      .set('Authorization', `Bearer ${masterJwt}`)
      .send(params)
      .expect(201);
    return (res.body as ApiResponse<IssuedKey>).data!;
  };

  const usdtSpot = (userId: string) =>
    prisma.wallet.findUnique({
      where: {
        userId_assetSymbol_marketType: { userId, assetSymbol: 'USDT', marketType: MarketType.SPOT },
      },
    });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PortalAppModule, AppModule],
    })
      .overrideProvider(KafkaService)
      .useValue({ emit: jest.fn(), onModuleInit: jest.fn(), onModuleDestroy: jest.fn() })
      .compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.useWebSocketAdapter(new WsAdapter(app));
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = app.get(PrismaService);
    server = app.getHttpServer();

    // USDT 자산 보장 (지갑 FK)
    await prisma.asset.upsert({
      where: { symbol: 'USDT' },
      update: {},
      create: { symbol: 'USDT', name: 'Tether', precision: 8, type: AssetType.STABLECOIN },
    });

    const master = await signup(app, masterEmail);
    masterJwt = master.accessToken;
    masterId = master.userId;
    // 수수료 상속 검증용으로 마스터 수수료를 기본값과 다르게
    await prisma.user.update({
      where: { id: masterId },
      data: { feeMakerBps: 7, feeTakerBps: 3 },
    });
    // 마스터 SPOT USDT 자금 (이체 테스트용)
    await prisma.wallet.upsert({
      where: {
        userId_assetSymbol_marketType: {
          userId: masterId,
          assetSymbol: 'USDT',
          marketType: MarketType.SPOT,
        },
      },
      update: { balance: '10000' },
      create: {
        userId: masterId,
        assetSymbol: 'USDT',
        marketType: MarketType.SPOT,
        balance: '10000',
      },
    });

    // 소유권 격리 테스트용 다른 마스터 + 그 서브
    const other = await signup(app, otherEmail);
    otherJwt = other.accessToken;
    otherId = other.userId;
    const otherSubRes = await request(server)
      .post('/subaccounts')
      .set('Authorization', `Bearer ${otherJwt}`)
      .send({ label: 'other-sub' })
      .expect(201);
    otherSubId = (otherSubRes.body as ApiResponse<Subaccount>).data!.id;
  });

  afterAll(async () => {
    const masters = [masterId, otherId];
    const subs = await prisma.user.findMany({
      where: { parentUserId: { in: masters } },
      select: { id: true },
    });
    const allIds = [...masters, ...subs.map((s) => s.id)];
    await prisma.apiKey.deleteMany({ where: { userId: { in: allIds } } });
    await prisma.fundingTx.deleteMany({ where: { userId: { in: allIds } } });
    await prisma.futuresIncome.deleteMany({ where: { userId: { in: allIds } } });
    await prisma.balanceSnapshot.deleteMany({ where: { userId: { in: allIds } } });
    await prisma.wallet.deleteMany({ where: { userId: { in: allIds } } });
    await prisma.authToken.deleteMany({ where: { userId: { in: allIds } } });
    await prisma.user.deleteMany({ where: { parentUserId: { in: masters } } });
    await prisma.user.deleteMany({ where: { id: { in: masters } } });
    await app.close();
  });

  describe('POST /subaccounts', () => {
    it('creates a subaccount that inherits the master fee rates', async () => {
      const res = await request(server)
        .post('/subaccounts')
        .set('Authorization', `Bearer ${masterJwt}`)
        .send({ label: 'arb-bot-1' })
        .expect(201);
      const body = res.body as ApiResponse<Subaccount>;
      expect(body.code).toBe(0);
      expect(body.data?.id).toBeDefined();
      expect(body.data?.label).toBe('arb-bot-1');
      expect(body.data?.feeMakerBps).toBe(7);
      expect(body.data?.feeTakerBps).toBe(3);

      // 서브계정은 실제 User 행이며 parentUserId가 마스터를 가리킨다
      const row = await prisma.user.findUnique({ where: { id: body.data!.id } });
      expect(row?.parentUserId).toBe(masterId);
    });

    it('rejects without JWT', async () => {
      await request(server).post('/subaccounts').send({ label: 'no-auth' }).expect(401);
    });

    it('rejects when authenticated via API key (escalation blocked — JwtOnly)', async () => {
      const key = await issueApiKey(app, masterJwt, { canTrade: true });
      const qs = `timestamp=${Date.now()}`;
      const sig = sign(key.secret, qs);
      await request(server)
        .post(`/subaccounts?${qs}&signature=${sig}`)
        .set('X-API-KEY', key.apiKey)
        .send({ label: 'via-key' })
        .expect(401);
    });
  });

  describe('GET /subaccounts', () => {
    it('lists the master’s subaccounts', async () => {
      const created = await createSub('listed-sub');
      const res = await request(server)
        .get('/subaccounts')
        .set('Authorization', `Bearer ${masterJwt}`)
        .expect(200);
      const list = (res.body as ApiResponse<Subaccount[]>).data!;
      expect(Array.isArray(list)).toBe(true);
      expect(list.find((s) => s.id === created.id)).toBeDefined();
      // 다른 마스터의 서브는 보이지 않는다
      expect(list.find((s) => s.id === otherSubId)).toBeUndefined();
    });
  });

  describe('POST /subaccounts/transfers', () => {
    it('moves SPOT balance master → sub and records both ledger sides', async () => {
      const sub = await createSub('fundee');
      const before = await usdtSpot(masterId);

      const res = await request(server)
        .post('/subaccounts/transfers')
        .set('Authorization', `Bearer ${masterJwt}`)
        .send({ fromAccountId: masterId, toAccountId: sub.id, assetSymbol: 'USDT', qty: '300' })
        .expect(201);
      expect((res.body as ApiResponse<{ qty: string }>).data?.qty).toBe('300.00000000');

      // 마스터 잔고 −300, 서브 잔고 +300
      const after = await usdtSpot(masterId);
      expect(Number(before!.balance) - Number(after!.balance)).toBe(300);

      const balRes = await request(server)
        .get(`/subaccounts/${sub.id}/balances`)
        .set('Authorization', `Bearer ${masterJwt}`)
        .expect(200);
      const bals = (balRes.body as ApiResponse<SubBalance[]>).data!;
      const usdt = bals.find((b) => b.assetSymbol === 'USDT' && b.marketType === 'SPOT');
      expect(usdt?.balance).toBe('300.00000000');

      // 양측 원장 1행씩 (방향 + counterparty)
      const txs = await prisma.fundingTx.findMany({
        where: { type: 'SUBACCOUNT_TRANSFER', userId: { in: [masterId, sub.id] } },
      });
      const out = txs.find((t) => t.userId === masterId);
      const inc = txs.find((t) => t.userId === sub.id);
      expect(out?.counterpartyUserId).toBe(sub.id);
      expect(out?.fromMarket).toBe('SPOT');
      expect(out?.toMarket).toBeNull();
      expect(inc?.counterpartyUserId).toBe(masterId);
      expect(inc?.toMarket).toBe('SPOT');
      expect(inc?.fromMarket).toBeNull();

      // 마스터의 거래내역에 SUBACCOUNT_TRANSFER가 노출된다
      const histRes = await request(server)
        .get('/account/transactions?type=SUBACCOUNT_TRANSFER')
        .set('Authorization', `Bearer ${masterJwt}`)
        .expect(200);
      const hist = (histRes.body as ApiResponse<TxRow[]>).data!;
      expect(hist.some((h) => h.counterpartyUserId === sub.id)).toBe(true);
    });

    it('moves balance sub → sub', async () => {
      const a = await createSub('chain-a');
      const b = await createSub('chain-b');
      await request(server)
        .post('/subaccounts/transfers')
        .set('Authorization', `Bearer ${masterJwt}`)
        .send({ fromAccountId: masterId, toAccountId: a.id, assetSymbol: 'USDT', qty: '100' })
        .expect(201);
      await request(server)
        .post('/subaccounts/transfers')
        .set('Authorization', `Bearer ${masterJwt}`)
        .send({ fromAccountId: a.id, toAccountId: b.id, assetSymbol: 'USDT', qty: '40' })
        .expect(201);

      expect(Number((await usdtSpot(a.id))!.balance)).toBe(60);
      expect(Number((await usdtSpot(b.id))!.balance)).toBe(40);
    });

    it('rejects insufficient balance (400, code 30002)', async () => {
      const sub = await createSub('poor');
      const res = await request(server)
        .post('/subaccounts/transfers')
        .set('Authorization', `Bearer ${masterJwt}`)
        .send({ fromAccountId: sub.id, toAccountId: masterId, assetSymbol: 'USDT', qty: '5' })
        .expect(400);
      expect((res.body as ApiResponse<null>).code).toBe(30002);
    });

    it('rejects same source and destination (400)', async () => {
      await request(server)
        .post('/subaccounts/transfers')
        .set('Authorization', `Bearer ${masterJwt}`)
        .send({ fromAccountId: masterId, toAccountId: masterId, assetSymbol: 'USDT', qty: '1' })
        .expect(400);
    });

    it('rejects an account outside the master’s family (404)', async () => {
      const res = await request(server)
        .post('/subaccounts/transfers')
        .set('Authorization', `Bearer ${masterJwt}`)
        .send({ fromAccountId: masterId, toAccountId: otherSubId, assetSymbol: 'USDT', qty: '1' })
        .expect(404);
      expect((res.body as ApiResponse<null>).code).toBe(90001);
    });
  });

  describe('Subaccount API keys + isolation', () => {
    it('issues a key that authenticates AS the subaccount (isolated wallets)', async () => {
      const sub = await createSub('keyed');
      await request(server)
        .post('/subaccounts/transfers')
        .set('Authorization', `Bearer ${masterJwt}`)
        .send({ fromAccountId: masterId, toAccountId: sub.id, assetSymbol: 'USDT', qty: '250' })
        .expect(201);

      const key = await issueSubKey(sub.id, { canRead: true, canTrade: true });
      expect(key.secret).toBeDefined();

      // 서브 키로 spot 잔고 조회 → 서브의 지갑(250)이 보인다
      const qs = `timestamp=${Date.now()}`;
      const sig = sign(key.secret, qs);
      const res = await request(server)
        .get(`/spot/account/balances?${qs}&signature=${sig}`)
        .set('X-API-KEY', key.apiKey)
        .expect(200);
      const rows = (res.body as ApiResponse<WalletRow[]>).data!;
      const usdt = rows.find((w) => w.assetSymbol === 'USDT' && w.marketType === 'SPOT');
      expect(usdt).toBeDefined();
      expect(Number(usdt!.balance)).toBe(250);

      // 격리: 자금 없는 다른 서브의 키는 USDT 잔고가 없다
      const empty = await createSub('empty');
      const emptyKey = await issueSubKey(empty.id, { canRead: true });
      const qs2 = `timestamp=${Date.now()}`;
      const sig2 = sign(emptyKey.secret, qs2);
      const res2 = await request(server)
        .get(`/spot/account/balances?${qs2}&signature=${sig2}`)
        .set('X-API-KEY', emptyKey.apiKey)
        .expect(200);
      const rows2 = (res2.body as ApiResponse<WalletRow[]>).data!;
      expect(rows2.find((w) => w.assetSymbol === 'USDT')).toBeUndefined();
    });

    it('lists then revokes a subaccount key; revoked key is rejected', async () => {
      const sub = await createSub('revoke-me');
      const key = await issueSubKey(sub.id, { canRead: true });

      const listRes = await request(server)
        .get(`/subaccounts/${sub.id}/api-keys`)
        .set('Authorization', `Bearer ${masterJwt}`)
        .expect(200);
      const keys = (listRes.body as ApiResponse<{ id: string }[]>).data!;
      expect(keys.find((k) => k.id === key.id)).toBeDefined();

      await request(server)
        .delete(`/subaccounts/${sub.id}/api-keys/${key.id}`)
        .set('Authorization', `Bearer ${masterJwt}`)
        .expect(204);

      const qs = `timestamp=${Date.now()}`;
      const sig = sign(key.secret, qs);
      await request(server)
        .get(`/spot/account/balances?${qs}&signature=${sig}`)
        .set('X-API-KEY', key.apiKey)
        .expect(401);
    });
  });

  describe('Ownership isolation', () => {
    it('another master cannot read a subaccount it does not own (404)', async () => {
      const sub = await createSub('private');
      const res = await request(server)
        .get(`/subaccounts/${sub.id}/balances`)
        .set('Authorization', `Bearer ${otherJwt}`)
        .expect(404);
      expect((res.body as ApiResponse<null>).code).toBe(90001);
    });

    it('another master cannot issue a key for a subaccount it does not own (404)', async () => {
      const sub = await createSub('private2');
      await request(server)
        .post(`/subaccounts/${sub.id}/api-keys`)
        .set('Authorization', `Bearer ${otherJwt}`)
        .send({ canRead: true })
        .expect(404);
    });
  });

  describe('Leaderboard excludes subaccounts', () => {
    it('a subaccount with a huge equity delta never appears on the public leaderboard', async () => {
      const sub = await createSub('whale-sub');
      // 마스터 cron이 쓰는 일별 스냅샷을 모사 — 서브에 큰 PnL 델타
      await prisma.balanceSnapshot.createMany({
        data: [
          {
            userId: sub.id,
            day: new Date('2020-01-01T00:00:00.000Z'),
            totalUsdt: '1',
            spotUsdt: '1',
            futuresUsdt: '0',
            breakdown: [],
          },
          {
            userId: sub.id,
            day: new Date('2020-01-02T00:00:00.000Z'),
            totalUsdt: '99999999',
            spotUsdt: '99999999',
            futuresUsdt: '0',
            breakdown: [],
          },
        ],
      });

      const res = await request(server)
        .get('/leaderboard?metric=PNL&window=ALL&limit=200')
        .expect(200);
      const rows = (res.body as ApiResponse<{ rows: { userId: string }[] }>).data!.rows;
      expect(rows.find((r) => r.userId === sub.id)).toBeUndefined();
    });
  });
});
