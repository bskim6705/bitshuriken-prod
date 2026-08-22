import { authenticator } from 'otplib';
import { TotpService } from './totp.service';

describe('TotpService', () => {
  const svc = new TotpService();

  it('verifies a freshly generated token', () => {
    const secret = svc.generateSecret();
    const token = authenticator.generate(secret);
    expect(svc.verify(token, secret)).toBe(true);
  });

  it('rejects empty / malformed codes deterministically', () => {
    const secret = svc.generateSecret();
    expect(svc.verify('', secret)).toBe(false);
    expect(svc.verify('1', secret)).toBe(false);
    expect(svc.verify('abcdef', secret)).toBe(false);
  });

  it('builds an otpauth URI with issuer + account', () => {
    const url = svc.otpauthUrl('alice@test.com', svc.generateSecret());
    expect(url).toContain('otpauth://totp/');
    expect(url).toContain('Bitshuriken');
    expect(url).toContain('alice%40test.com');
  });

  it('renders a PNG QR data URL', async () => {
    const url = svc.otpauthUrl('a@b.com', svc.generateSecret());
    const dataUrl = await svc.qrDataUrl(url);
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });
});
