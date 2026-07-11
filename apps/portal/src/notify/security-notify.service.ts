import { Injectable, Logger } from '@nestjs/common';
import { MailService } from '@app/core-domain/mail/mail.service';

/**
 * 보안 이벤트 알림 메일 — 전부 best-effort(발송 실패가 원 작업을 깨지 않게).
 * 모든 이메일 트리거가 portal 엔드포인트라 여기 모아 둔다. 안티피싱 배너는 MailService가 붙인다.
 */
@Injectable()
export class SecurityNotifyService {
  private readonly logger = new Logger(SecurityNotifyService.name);

  constructor(private readonly mail: MailService) {}

  loginAlert(to: string, ip: string, userAgent: string | null): void {
    const ua = userAgent ? `\nDevice: ${userAgent}` : '';
    this.fire(
      to,
      'New sign-in to your account',
      `A sign-in to your Bitshuriken account came from a new IP address.\n\nIP: ${ip}${ua}\n\nIf this was you, no action is needed. If not, change your password and review your active sessions immediately.`,
    );
  }

  passwordChanged(to: string): void {
    this.fire(
      to,
      'Your password was changed',
      `Your Bitshuriken account password was just changed, and all other sessions were signed out.\n\nIf you did not do this, reset your password and contact support.`,
    );
  }

  twoFactorEnabled(to: string): void {
    this.fire(
      to,
      'Two-factor authentication enabled',
      `Two-factor authentication was enabled on your Bitshuriken account.\n\nIf you did not do this, contact support immediately.`,
    );
  }

  twoFactorDisabled(to: string): void {
    this.fire(
      to,
      'Two-factor authentication disabled',
      `Two-factor authentication was disabled on your Bitshuriken account.\n\nIf you did not do this, secure your account and contact support immediately.`,
    );
  }

  apiKeyCreated(to: string, label: string | null): void {
    const which = label ? ` ("${label}")` : '';
    this.fire(
      to,
      'A new API key was created',
      `A new API key${which} was created on your Bitshuriken account.\n\nIf you did not do this, revoke it from the API keys page and change your password.`,
    );
  }

  withdrawalConfirmation(to: string, assetSymbol: string, qty: string): void {
    this.fire(
      to,
      'Withdrawal processed',
      `A withdrawal was processed on your Bitshuriken account.\n\nAsset: ${assetSymbol}\nAmount: ${qty}\n\nIf you did not do this, secure your account immediately.`,
    );
  }

  private fire(to: string, subject: string, text: string): void {
    void this.mail
      .sendNotice(to, subject, text)
      .catch((e: unknown) => this.logger.warn(`notify "${subject}" to ${to} failed: ${String(e)}`));
  }
}
