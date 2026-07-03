import { PrismaService } from '@app/infra/prisma/prisma.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { TwoFactorService } from '@app/core-domain/two-factor/two-factor.service';
import { FundingService } from './funding.service';

// 출금 게이트는 별도 검증 — 여기선 통과(이메일 인증됨 + 2FA off)로 모킹
const twoFactor = {
  assertForUser: jest.fn(),
  assertSatisfied: jest.fn(() => Promise.resolve()),
} as unknown as TwoFactorService;

function makeDb(over: { assetExists?: boolean; debitCount?: number } = {}) {
  const client = {
    asset: {
      findUnique: jest.fn(() =>
        Promise.resolve(over.assetExists === false ? null : { symbol: 'USDT' }),
      ),
    },
    user: {
      findUnique: jest.fn(() =>
        Promise.resolve({ emailVerified: true, withdrawalEnabled: true, twoFactorEnabled: false, twoFactorSecret: null }),
      ),
    },
    wallet: {
      upsert: jest.fn(() => Promise.resolve({})),
      updateMany: jest.fn(() => Promise.resolve({ count: over.debitCount ?? 1 })),
    },
    fundingTx: {
      create: jest.fn(() => Promise.resolve({ id: 'ftx_1' })),
    },
  };
  // $transaction은 콜백에 같은 mock client를 넘겨 즉시 실행
  const prisma = {
    ...client,
    $transaction: jest.fn((cb: (t: typeof client) => unknown) => cb(client)),
  };
  return { prisma: prisma as unknown as PrismaService, raw: prisma };
}

const dto = { assetSymbol: 'USDT', qty: '100' };

describe('FundingService', () => {
  describe('deposit', () => {
    it('SPOT 지갑에 즉시 가산하고 8자리 qty를 반환한다', async () => {
      const { prisma, raw } = makeDb();
      const service = new FundingService(prisma, twoFactor);
      const res = await service.deposit('A', dto);
      expect(raw.wallet.upsert).toHaveBeenCalledTimes(1);
      const arg = raw.wallet.upsert.mock.calls[0][0] as {
        where: { userId_assetSymbol_marketType: { marketType: string } };
      };
      expect(arg.where.userId_assetSymbol_marketType.marketType).toBe('SPOT');
      expect(res.qty).toBe('100.00000000');
      expect(res.depositId).toBeDefined();
    });

    it('존재하지 않는 asset이면 거부한다', async () => {
      const { prisma } = makeDb({ assetExists: false });
      const service = new FundingService(prisma, twoFactor);
      await expect(service.deposit('A', { ...dto, assetSymbol: 'NOPE' })).rejects.toMatchObject({
        code: ErrorCode.INVALID_PARAMETER,
      });
    });
  });

  describe('withdraw', () => {
    it('잔고 조건부 차감이 성공하면 8자리 qty를 반환한다', async () => {
      const { prisma, raw } = makeDb();
      const service = new FundingService(prisma, twoFactor);
      const res = await service.withdraw('A', dto);
      const arg = raw.wallet.updateMany.mock.calls[0][0] as {
        where: { marketType: string; balance: { gte: unknown } };
      };
      expect(arg.where.marketType).toBe('SPOT');
      expect(arg.where.balance.gte).toBeDefined();
      expect(res.qty).toBe('100.00000000');
    });

    it('잔고 부족(차감 0건)이면 INSUFFICIENT_BALANCE', async () => {
      const { prisma } = makeDb({ debitCount: 0 });
      const service = new FundingService(prisma, twoFactor);
      await expect(service.withdraw('A', dto)).rejects.toMatchObject({
        code: ErrorCode.INSUFFICIENT_BALANCE,
      });
    });
  });

  describe('qty 검증', () => {
    it.each(['0', '-1', '0.000000001'])('qty=%s 거부', async (qty) => {
      const { prisma } = makeDb();
      const service = new FundingService(prisma, twoFactor);
      await expect(service.deposit('A', { ...dto, qty })).rejects.toBeInstanceOf(DomainException);
      await expect(service.withdraw('A', { ...dto, qty })).rejects.toBeInstanceOf(DomainException);
    });
  });
});
