import { PrismaService } from '@app/infra/prisma/prisma.service';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { TotpService } from '../totp/totp.service';
import { EncryptionService } from '../crypto/encryption.service';
import { TwoFactorService, TwoFactorState } from './two-factor.service';

const GOOD = '123456';

function make(state: TwoFactorState | null) {
  const findUnique = jest.fn(() => Promise.resolve(state));
  const update = jest.fn(() => Promise.resolve({}));
  const prisma = { user: { findUnique, update } };
  // enc는 identity로 모킹 — decrypt(encrypt(x)) === x 의미만 유지
  const enc = {
    encrypt: jest.fn((s: string) => `enc(${s})`),
    decrypt: jest.fn((s: string) => s.replace(/^enc\(|\)$/g, '')),
  };
  const totp = {
    generateSecret: jest.fn(() => 'SECRET'),
    otpauthUrl: jest.fn(() => 'otpauth://totp/x'),
    qrDataUrl: jest.fn(() => Promise.resolve('data:image/png;base64,zz')),
    verify: jest.fn((code: string) => code === GOOD),
  };
  const svc = new TwoFactorService(
    prisma as unknown as PrismaService,
    totp as unknown as TotpService,
    enc as unknown as EncryptionService,
  );
  return { svc, findUnique, update, enc, totp };
}

describe('TwoFactorService', () => {
  describe('setup', () => {
    it('stores an encrypted secret (disabled) and returns otpauth + qr', async () => {
      const { svc, update } = make({ twoFactorEnabled: false, twoFactorSecret: null });
      const res = await svc.setup('U', 'a@b.com');
      expect(res.secret).toBe('SECRET');
      expect(res.otpauthUrl).toBe('otpauth://totp/x');
      expect(res.qrDataUrl).toContain('data:image/png');
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { twoFactorSecret: 'enc(SECRET)' } }),
      );
    });

    it('rejects when already enabled', async () => {
      const { svc } = make({ twoFactorEnabled: true, twoFactorSecret: 'enc(SECRET)' });
      await expect(svc.setup('U', 'a@b.com')).rejects.toMatchObject({
        code: ErrorCode.TWO_FACTOR_ALREADY_ENABLED,
      });
    });
  });

  describe('enable', () => {
    it('enables when the code is valid', async () => {
      const { svc, update } = make({ twoFactorEnabled: false, twoFactorSecret: 'enc(SECRET)' });
      await svc.enable('U', GOOD);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { twoFactorEnabled: true } }),
      );
    });

    it('rejects an invalid code', async () => {
      const { svc } = make({ twoFactorEnabled: false, twoFactorSecret: 'enc(SECRET)' });
      await expect(svc.enable('U', '000000')).rejects.toMatchObject({
        code: ErrorCode.INVALID_TWO_FACTOR_CODE,
      });
    });

    it('rejects when setup was never run', async () => {
      const { svc } = make({ twoFactorEnabled: false, twoFactorSecret: null });
      await expect(svc.enable('U', GOOD)).rejects.toMatchObject({
        code: ErrorCode.TWO_FACTOR_NOT_ENABLED,
      });
    });
  });

  describe('disable', () => {
    it('clears secret + flag with a valid code', async () => {
      const { svc, update } = make({ twoFactorEnabled: true, twoFactorSecret: 'enc(SECRET)' });
      await svc.disable('U', GOOD);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { twoFactorEnabled: false, twoFactorSecret: null } }),
      );
    });

    it('rejects an invalid code', async () => {
      const { svc } = make({ twoFactorEnabled: true, twoFactorSecret: 'enc(SECRET)' });
      await expect(svc.disable('U', '000000')).rejects.toMatchObject({
        code: ErrorCode.INVALID_TWO_FACTOR_CODE,
      });
    });
  });

  describe('assertForUser', () => {
    it('is a no-op when 2FA is disabled', () => {
      const { svc } = make(null);
      expect(() =>
        svc.assertForUser({ twoFactorEnabled: false, twoFactorSecret: null }),
      ).not.toThrow();
    });

    it('requires a code when enabled', () => {
      const { svc } = make(null);
      expect(() =>
        svc.assertForUser({ twoFactorEnabled: true, twoFactorSecret: 'enc(SECRET)' }),
      ).toThrow();
    });

    it('fails closed when enabled but the secret is missing (data inconsistency)', () => {
      const { svc } = make(null);
      expect(() =>
        svc.assertForUser({ twoFactorEnabled: true, twoFactorSecret: null }, '123456'),
      ).toThrow();
    });

    it('rejects a bad code and accepts a good one', () => {
      const { svc } = make(null);
      const state: TwoFactorState = { twoFactorEnabled: true, twoFactorSecret: 'enc(SECRET)' };
      expect(() => svc.assertForUser(state, '000000')).toThrow();
      expect(() => svc.assertForUser(state, GOOD)).not.toThrow();
    });
  });
});
