import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

/**
 * SMTP 메일 발송 (ADR-044). 설정은 env에서 — 부재 시 부팅 실패(loud).
 * 로컬 dev는 인증 없는 SMTP(Mailpit/Mailhog localhost:1025) 사용 가능.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly appBaseUrl: string;

  constructor() {
    const host = process.env.SMTP_HOST;
    const portRaw = process.env.SMTP_PORT;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    this.from = process.env.MAIL_FROM ?? '';
    this.appBaseUrl = (process.env.APP_BASE_URL ?? '').replace(/\/$/, '');

    const missing: string[] = [];
    if (!host) missing.push('SMTP_HOST');
    if (!portRaw) missing.push('SMTP_PORT');
    if (!this.from) missing.push('MAIL_FROM');
    if (!this.appBaseUrl) missing.push('APP_BASE_URL');
    if (missing.length) {
      throw new Error(`Mail config missing: ${missing.join(', ')}`);
    }
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`SMTP_PORT must be a positive integer, got "${portRaw ?? ''}"`);
    }

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: process.env.SMTP_SECURE === 'true', // 465=true, 587/1025=false
      auth: user && pass ? { user, pass } : undefined, // dev SMTP는 인증 없음
    });
  }

  async sendEmailVerification(to: string, token: string): Promise<void> {
    const link = `${this.appBaseUrl}/verify-email?token=${encodeURIComponent(token)}`;
    await this.send(
      to,
      'Verify your email',
      `Confirm your Bitshuriken email address:\n\n${link}\n\nThis link expires in 24 hours.`,
    );
  }

  async sendPasswordReset(to: string, token: string): Promise<void> {
    const link = `${this.appBaseUrl}/reset-password?token=${encodeURIComponent(token)}`;
    await this.send(
      to,
      'Reset your password',
      `Reset your Bitshuriken password:\n\n${link}\n\nThis link expires in 1 hour. If you did not request this, ignore this email.`,
    );
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
    await this.transporter.sendMail({ from: this.from, to, subject, text });
    this.logger.log(`Sent "${subject}" to ${to}`);
  }
}
