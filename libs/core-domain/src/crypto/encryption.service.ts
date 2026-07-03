import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_HEX_LEN = 64; // 32 bytes

/**
 * AES-256-GCM 봉투 암호화 (ADR-044). API key secret / TOTP secret을 DB에 암호문으로 저장.
 * 키는 env `API_KEY_ENCRYPTION_KEY` (32바이트 hex). 부재/형식오류면 부팅 실패.
 * 출력 포맷: `ivHex:tagHex:ciphertextHex`.
 */
@Injectable()
export class EncryptionService {
  private readonly key: Buffer;

  constructor() {
    const hex = process.env.API_KEY_ENCRYPTION_KEY;
    if (!hex || hex.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error(
        'API_KEY_ENCRYPTION_KEY must be 32 bytes hex (64 hex chars). Generate: openssl rand -hex 32',
      );
    }
    this.key = Buffer.from(hex, 'hex');
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
  }

  /** 위조/변조 시 GCM auth tag 검증 실패로 throw. */
  decrypt(payload: string): string {
    const parts = payload.split(':');
    if (parts.length !== 3) throw new Error('Malformed ciphertext payload');
    const [ivHex, tagHex, dataHex] = parts;
    const decipher = crypto.createDecipheriv(ALGO, this.key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString(
      'utf8',
    );
  }
}
