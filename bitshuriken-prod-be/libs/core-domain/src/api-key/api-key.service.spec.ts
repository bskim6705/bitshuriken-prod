import { Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { ApiKeyService } from './api-key.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

const SECRET = 'test-secret';

function makeRecord(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'key-1',
    userId: 'user-1',
    apiKey: 'pub-key',
    secretEncrypted: 'enc(test-secret)',
    label: null,
    canTrade: true,
    canRead: true,
    ipWhitelist: [] as string[],
    expiresAt: null as Date | null,
    createdAt: new Date(0),
    lastUsedAt: null as Date | null,
    revokedAt: null as Date | null,
    ...over,
  };
}

function sign(queryString: string, body: string): string {
  return crypto.createHmac('sha256', SECRET).update(queryString + body).digest('hex');
}

function makeService(base = makeRecord()) {
  const calls = { findUnique: 0, update: 0, decrypt: 0 };
  const state = { revokedAt: base.revokedAt as Date | null };
  const current = () => ({ ...base, revokedAt: state.revokedAt });
  const prisma = {
    apiKey: {
      findUnique: jest.fn(() => {
        calls.findUnique++;
        return Promise.resolve(current());
      }),
      update: jest.fn(({ data }: { data: { revokedAt?: Date } }) => {
        calls.update++;
        if (data.revokedAt !== undefined) state.revokedAt = data.revokedAt;
        return Promise.resolve(current());
      }),
    },
  };
  const enc = {
    decrypt: jest.fn(() => {
      calls.decrypt++;
      return SECRET;
    }),
    encrypt: jest.fn(),
  };
  const twoFactor = { assertSatisfied: jest.fn() };
  const svc = new ApiKeyService(prisma as never, enc as never, twoFactor as never);
  return { svc, prisma, enc, calls };
}

describe('ApiKeyService.verifySignature caching', () => {
  const qs = 'timestamp=1&symbol=BTCUSDT';
  const body = '{"a":1}';

  afterEach(() => jest.restoreAllMocks());

  it('hits DB + decrypt once, then serves from cache (read 0 / decrypt 0)', async () => {
    const { svc, calls } = makeService();
    const params = { apiKey: 'pub-key', queryString: qs, body, providedSignature: sign(qs, body) };

    await svc.verifySignature(params);
    await svc.verifySignature(params);
    await svc.verifySignature(params);

    expect(calls.findUnique).toBe(1);
    expect(calls.decrypt).toBe(1);
  });

  it('re-reads DB after cache TTL expiry', async () => {
    const { svc, calls } = makeService();
    const params = { apiKey: 'pub-key', queryString: qs, body, providedSignature: sign(qs, body) };

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    await svc.verifySignature(params);
    nowSpy.mockReturnValue(1_000_000 + 9_999); // < 10s TTL
    await svc.verifySignature(params);
    expect(calls.findUnique).toBe(1);

    nowSpy.mockReturnValue(1_000_000 + 10_001); // > 10s TTL
    await svc.verifySignature(params);
    expect(calls.findUnique).toBe(2);
  });

  it('revoke evicts cache in-process (subsequent verify re-reads and 401s)', async () => {
    const { svc, calls } = makeService();
    const params = { apiKey: 'pub-key', queryString: qs, body, providedSignature: sign(qs, body) };

    await svc.verifySignature(params); // populates cache
    expect(calls.findUnique).toBe(1);

    await svc.revoke('user-1', 'key-1'); // sets revokedAt + evicts cache entry
    const readsAfterRevoke = calls.findUnique;

    await expect(svc.verifySignature(params)).rejects.toMatchObject({
      code: ErrorCode.INVALID_API_KEY,
    });
    expect(calls.findUnique).toBeGreaterThan(readsAfterRevoke); // re-read, saw revoked
  });

  it('rejects a bad signature (cache does not bypass HMAC)', async () => {
    const { svc } = makeService();
    await expect(
      svc.verifySignature({ apiKey: 'pub-key', queryString: qs, body, providedSignature: 'deadbeef' }),
    ).rejects.toBeInstanceOf(DomainException);
  });
});

describe('ApiKeyService.touchLastUsed throttle', () => {
  const qs = 'timestamp=1';
  const body = '';

  afterEach(() => jest.restoreAllMocks());

  it('writes at most once per throttle window, then again after it elapses', async () => {
    const { svc, calls } = makeService();
    const params = { apiKey: 'pub-key', queryString: qs, body, providedSignature: sign(qs, body) };

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(5_000_000);
    await svc.verifySignature(params);
    await svc.verifySignature(params);
    nowSpy.mockReturnValue(5_000_000 + 59_000); // still within 60s throttle
    await svc.verifySignature(params);
    await flush();
    expect(calls.update).toBe(1);

    nowSpy.mockReturnValue(5_000_000 + 61_000); // throttle elapsed
    await svc.verifySignature(params);
    await flush();
    expect(calls.update).toBe(2);
  });

  it('logs a warning instead of throwing when the update rejects', async () => {
    const { svc, prisma } = makeService();
    (prisma.apiKey.update as jest.Mock).mockRejectedValue(new Error('pool timeout'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const params = { apiKey: 'pub-key', queryString: qs, body, providedSignature: sign(qs, body) };

    await expect(svc.verifySignature(params)).resolves.toMatchObject({ id: 'key-1' });
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lastUsedAt update failed'));
  });
});

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
