import { UserRole } from '@prisma/client';
import { UserService } from './user.service';
import { ErrorCode } from '@app/shared/constants/error-codes';

function makeUser(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user-1',
    email: 'u@x.com',
    role: UserRole.USER,
    rateLimitExempt: false,
    tradingEnabled: true,
    ...over,
  };
}

function makeService(user: ReturnType<typeof makeUser> | null = makeUser()) {
  const calls = { findUnique: 0 };
  const prisma = {
    user: {
      findUnique: jest.fn(() => {
        calls.findUnique++;
        return Promise.resolve(user);
      }),
    },
  };
  const svc = new UserService(prisma as never);
  return { svc, prisma, calls };
}

describe('UserService.authContextOf', () => {
  afterEach(() => jest.restoreAllMocks());

  it('caches: two calls within TTL do one DB read', async () => {
    const { svc, calls } = makeService();
    await svc.authContextOf('user-1');
    await svc.authContextOf('user-1');
    expect(calls.findUnique).toBe(1);
  });

  it('re-reads after TTL expiry', async () => {
    const { svc, calls } = makeService();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await svc.authContextOf('user-1');
    nowSpy.mockReturnValue(1_000_000 + 4_999); // < 5s TTL
    await svc.authContextOf('user-1');
    expect(calls.findUnique).toBe(1);
    nowSpy.mockReturnValue(1_000_000 + 5_001); // > 5s TTL
    await svc.authContextOf('user-1');
    expect(calls.findUnique).toBe(2);
  });

  it('returns null for a missing user (no caching of null)', async () => {
    const { svc, calls } = makeService(null);
    expect(await svc.authContextOf('nope')).toBeNull();
    await svc.authContextOf('nope');
    expect(calls.findUnique).toBe(2);
  });
});

describe('UserService.assertCanTrade reuse', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reuses the auth-context cache the guard populated (0 extra reads)', async () => {
    const { svc, calls } = makeService();
    await svc.authContextOf('user-1'); // guard path
    await svc.assertCanTrade('user-1'); // order path
    expect(calls.findUnique).toBe(1);
  });

  it('throws ACCOUNT_TRADING_DISABLED when tradingEnabled is false', async () => {
    const { svc } = makeService(makeUser({ tradingEnabled: false }));
    await expect(svc.assertCanTrade('user-1')).rejects.toMatchObject({
      code: ErrorCode.ACCOUNT_TRADING_DISABLED,
    });
  });

  it('throws USER_NOT_FOUND when the user is missing', async () => {
    const { svc } = makeService(null);
    await expect(svc.assertCanTrade('nope')).rejects.toMatchObject({
      code: ErrorCode.USER_NOT_FOUND,
    });
  });
});
