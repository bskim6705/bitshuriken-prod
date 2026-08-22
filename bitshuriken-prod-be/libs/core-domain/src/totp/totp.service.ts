import { Injectable } from '@nestjs/common';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';

const ISSUER = 'Bitshuriken';

/** RFC 6238 TOTP wrapper (otplib). ±1 step(±30s) 시계 오차 허용. */
@Injectable()
export class TotpService {
  constructor() {
    authenticator.options = { window: 1 };
  }

  generateSecret(): string {
    return authenticator.generateSecret();
  }

  /** 인증 앱 등록용 otpauth:// URI (label = 계정 이메일). */
  otpauthUrl(accountName: string, secret: string): string {
    return authenticator.keyuri(accountName, ISSUER, secret);
  }

  verify(token: string, secret: string): boolean {
    try {
      return authenticator.verify({ token, secret });
    } catch {
      return false;
    }
  }

  qrDataUrl(otpauthUrl: string): Promise<string> {
    return QRCode.toDataURL(otpauthUrl);
  }
}
