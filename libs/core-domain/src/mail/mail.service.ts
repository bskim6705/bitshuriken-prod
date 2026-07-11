import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { PrismaService } from '@app/infra/prisma/prisma.service';

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

  constructor(private prisma: PrismaService) {
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

  /** 보안 알림 등 자유 본문 메일 (링크 없음). 안티피싱 배너는 send()가 붙인다. */
  async sendNotice(to: string, subject: string, text: string): Promise<void> {
    await this.send(to, subject, text);
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
    const body = await this.withAntiPhishingBanner(to, text);
    await this.transporter.sendMail({ from: this.from, to, subject, text: body });
    this.logger.log(`Sent "${subject}" to ${to}`);
  }

  /** 수신자가 안티피싱 코드를 설정했으면 본문 상단에 배너를 붙인다(모든 발신 메일 공통). */
  private async withAntiPhishingBanner(to: string, text: string): Promise<string> {
    const user = await this.prisma.user
      .findUnique({ where: { email: to }, select: { antiPhishingCode: true } })
      .catch(() => null);
    const code = user?.antiPhishingCode;
    if (!code) return text;
    return `[Anti-phishing code: ${code}]\n\n${text}`;
  }
}
