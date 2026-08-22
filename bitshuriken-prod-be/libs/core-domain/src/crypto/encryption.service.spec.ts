import { EncryptionService } from './encryption.service';

const TEST_KEY = 'a'.repeat(64); // 32 bytes hex

describe('EncryptionService', () => {
  let prev: string | undefined;

  beforeAll(() => {
    prev = process.env.API_KEY_ENCRYPTION_KEY;
    process.env.API_KEY_ENCRYPTION_KEY = TEST_KEY;
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.API_KEY_ENCRYPTION_KEY;
    else process.env.API_KEY_ENCRYPTION_KEY = prev;
  });

  it('roundtrips plaintext', () => {
    const enc = new EncryptionService();
    const secret = 's3cr3t-value_base64url';
    expect(enc.decrypt(enc.encrypt(secret))).toBe(secret);
  });

  it('produces a different ciphertext each call (random IV)', () => {
    const enc = new EncryptionService();
    expect(enc.encrypt('same')).not.toBe(enc.encrypt('same'));
  });

  it('throws when the ciphertext is tampered (GCM auth tag)', () => {
    const enc = new EncryptionService();
    const payload = enc.encrypt('secret');
    const [iv, tag, data] = payload.split(':');
    const flipped = data[0] === '0' ? '1' : '0';
    const tampered = `${iv}:${tag}:${flipped}${data.slice(1)}`;
    expect(() => enc.decrypt(tampered)).toThrow();
  });

  it('throws on malformed payload', () => {
    const enc = new EncryptionService();
    expect(() => enc.decrypt('not-a-valid-payload')).toThrow('Malformed ciphertext payload');
  });

  it('throws at construction when the key is missing or wrong length', () => {
    const saved = process.env.API_KEY_ENCRYPTION_KEY;
    process.env.API_KEY_ENCRYPTION_KEY = 'tooshort';
    expect(() => new EncryptionService()).toThrow(/32 bytes hex/);
    delete process.env.API_KEY_ENCRYPTION_KEY;
    expect(() => new EncryptionService()).toThrow(/32 bytes hex/);
    process.env.API_KEY_ENCRYPTION_KEY = saved;
  });
});
