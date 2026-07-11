import { Injectable, HttpStatus, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthTokenType, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { SignupDto } from './dto/signup.dto';
import { LoginDto } from './dto/login.dto';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { MailService } from '../mail/mail.service';
import { TwoFactorService } from '../two-factor/two-factor.service';
import { SessionService } from './session.service';

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1h
const ANTI_PHISHING_MAX = 32;
const LOGIN_HISTORY_MAX = 100;

export interface UserProfile {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  antiPhishingCode: string | null;
  role: UserRole;
  createdAt: Date;
}

interface UserRecord {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  antiPhishingCode: string | null;
  role: UserRole;
  createdAt: Date;
}

/** 로그인/가입 요청의 원천 정보 — 세션 행 + 로그인 이력에 기록. */
export interface LoginContext {
  ip: string;
  userAgent: string | null;
}

const DISPLAY_NAME_MAX = 24;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private mail: MailService,
    private twoFactor: TwoFactorService,
    private sessions: SessionService,
  ) {}

  async signup(dto: SignupDto, ctx: LoginContext) {
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (exists)
      throw new DomainException(
        ErrorCode.USER_ALREADY_EXISTS,
        'Email already exists',
        HttpStatus.CONFLICT,
      );

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const user = await this.prisma.user.create({
      data: { email: dto.email, hashedPassword },
    });

    // 인증 메일은 best-effort — SMTP 일시 장애가 가입을 막지 않게. 재발송 endpoint 있음.
    await this.sendVerification(user.id, user.email).catch((e: unknown) =>
      this.logger.warn(`verification email failed for user ${user.id}: ${String(e)}`),
    );

    // 가입 IP를 known 집합에 시드 → 이후 다른 IP 첫 로그인이 알림을 낸다.
    await this.recordLogin(user.id, ctx, true);
    const session = await this.issueSession(user, ctx);
    return { ...session, newIp: false };
  }

  async login(dto: LoginDto, ctx: LoginContext) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // 미존재 email은 이력 기록 없음(붙일 대상 없음) — 열거 방지 위해 응답은 동일.
    if (!user)
      throw new DomainException(
        ErrorCode.INVALID_CREDENTIALS,
        'Invalid credentials',
        HttpStatus.UNAUTHORIZED,
      );

    const valid = await bcrypt.compare(dto.password, user.hashedPassword);
    if (!valid) {
      await this.recordLogin(user.id, ctx, false);
      throw new DomainException(
        ErrorCode.INVALID_CREDENTIALS,
        'Invalid credentials',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // 2FA 사용자는 TOTP 코드 필수 (미사용자는 no-op → 기존 흐름 불변)
    try {
      this.twoFactor.assertForUser(user, dto.totpCode);
    } catch (e) {
      await this.recordLogin(user.id, ctx, false);
      throw e;
    }

    // 계정 정지 — 자격 확인 후 차단 (잘못된 비번엔 상태 비노출)
    if (!user.loginEnabled) {
      await this.recordLogin(user.id, ctx, false);
      throw new DomainException(
        ErrorCode.ACCOUNT_LOGIN_DISABLED,
        'Sign-in is disabled for this account',
        HttpStatus.FORBIDDEN,
      );
    }

    const newIp = await this.isNewIp(user.id, ctx.ip);
    await this.recordLogin(user.id, ctx, true);
    await this.cleanupExpiredSessions(user.id);
    const session = await this.issueSession(user, ctx);
    return { ...session, newIp };
  }

  async logout(rawToken: string | null | undefined): Promise<void> {
    if (!rawToken) return;
    try {
      const payload = this.jwt.verify<{ sub?: string; sid?: string }>(rawToken);
      if (payload.sub && payload.sid) await this.sessions.revoke(payload.sub, payload.sid);
    } catch {
      // 만료/위조 토큰 — 조용히 무시(로그아웃은 항상 성공 semantics)
    }
  }

  async getProfile(userId: string): Promise<UserProfile> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user)
      throw new DomainException(
        ErrorCode.USER_NOT_FOUND,
        'User not found',
        HttpStatus.UNAUTHORIZED,
      );
    return this.toProfile(user);
  }

  /**
   * 비밀번호 변경. 2FA 사용자는 TOTP 필수. 성공 시 현재 세션만 남기고 나머지 revoke.
   * 이메일 발송은 호출부(컨트롤러) 책임.
   */
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
    totpCode: string | undefined,
    currentSessionId: string | undefined,
  ): Promise<{ email: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user)
      throw new DomainException(ErrorCode.USER_NOT_FOUND, 'User not found', HttpStatus.NOT_FOUND);
    const valid = await bcrypt.compare(oldPassword, user.hashedPassword);
    if (!valid)
      throw new DomainException(
        ErrorCode.INVALID_CREDENTIALS,
        'Current password is incorrect',
        HttpStatus.UNAUTHORIZED,
      );
    this.twoFactor.assertForUser(user, totpCode);
    await this.prisma.user.update({
      where: { id: userId },
      data: { hashedPassword: await bcrypt.hash(newPassword, 10) },
    });
    // 비번 변경 후 타 세션 무효화 — 비번이 이미 바뀌었으니 revoke 실패로 요청을 깨지 않는다.
    if (currentSessionId) {
      await this.sessions
        .revokeAllExcept(userId, currentSessionId)
        .catch((e: unknown) => this.logger.warn(`session revoke failed after pw change: ${String(e)}`));
    }
    return { email: user.email };
  }

  /** 안티피싱 코드 설정/해제 — 2FA 게이트. 빈 문자열이면 해제. */
  async setAntiPhishingCode(
    userId: string,
    raw: string | null,
    totpCode: string | undefined,
  ): Promise<UserProfile> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user)
      throw new DomainException(ErrorCode.USER_NOT_FOUND, 'User not found', HttpStatus.NOT_FOUND);
    this.twoFactor.assertForUser(user, totpCode);

    const trimmed = raw?.trim() ?? '';
    const code: string | null = trimmed.length === 0 ? null : trimmed;
    if (code !== null) {
      if (code.length > ANTI_PHISHING_MAX)
        throw new DomainException(
          ErrorCode.INVALID_PARAMETER,
          `Anti-phishing code must be at most ${ANTI_PHISHING_MAX} characters`,
        );
      if (!/^[\w .!?@#-]+$/.test(code))
        throw new DomainException(
          ErrorCode.INVALID_PARAMETER,
          'Anti-phishing code contains unsupported characters',
        );
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { antiPhishingCode: code },
    });
    return this.toProfile(updated);
  }

  async getLoginHistory(userId: string, limit = LOGIN_HISTORY_MAX) {
    const take = Math.min(Math.max(limit, 1), LOGIN_HISTORY_MAX);
    return this.prisma.loginHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
      select: { id: true, ip: true, userAgent: true, success: true, createdAt: true },
    });
  }

  /** 리더보드 공개 이름 설정. 빈 문자열/null이면 해제(마스킹 이메일로 표시). */
  async updateDisplayName(userId: string, raw: string | null): Promise<UserProfile> {
    const trimmed = raw?.trim() ?? '';
    const displayName: string | null = trimmed.length === 0 ? null : trimmed;
    if (displayName !== null) {
      if (displayName.length > DISPLAY_NAME_MAX)
        throw new DomainException(
          ErrorCode.INVALID_PARAMETER,
          `Display name must be at most ${DISPLAY_NAME_MAX} characters`,
        );
      if (!/^[\w .-]+$/.test(displayName))
        throw new DomainException(
          ErrorCode.INVALID_PARAMETER,
          'Display name may contain letters, digits, spaces, and . _ -',
        );
    }
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { displayName },
    });
    return this.toProfile(user);
  }

  // ---- email verification ----

  async resendVerification(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user)
      throw new DomainException(ErrorCode.USER_NOT_FOUND, 'User not found', HttpStatus.NOT_FOUND);
    if (user.emailVerified)
      throw new DomainException(
        ErrorCode.EMAIL_ALREADY_VERIFIED,
        'Email already verified',
        HttpStatus.CONFLICT,
      );
    await this.sendVerification(user.id, user.email);
  }

  async verifyEmail(rawToken: string): Promise<void> {
    const userId = await this.consumeToken(rawToken, AuthTokenType.EMAIL_VERIFY);
    await this.prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
  }

  // ---- password reset ----

  /** 사용자 존재 여부를 노출하지 않음 — 호출부는 항상 일반 200 반환. */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return;
    const token = await this.createToken(
      user.id,
      AuthTokenType.PASSWORD_RESET,
      PASSWORD_RESET_TTL_MS,
    );
    // 메일 발송을 await하지 않음 — 계정 존재/비존재 간 응답 시간 차(SMTP 지연)로 인한 enumeration 방지
    void this.mail
      .sendPasswordReset(user.email, token)
      .catch((e: unknown) => this.logger.warn(`password reset email failed: ${String(e)}`));
  }

  /** 토큰 기반 비번 재설정. 전 세션 revoke(탈취 대응). 이메일 발송은 호출부 책임. */
  async resetPassword(rawToken: string, newPassword: string): Promise<{ email: string }> {
    const userId = await this.consumeToken(rawToken, AuthTokenType.PASSWORD_RESET);
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { hashedPassword: await bcrypt.hash(newPassword, 10) },
      select: { email: true },
    });
    await this.sessions
      .revokeAll(userId)
      .catch((e: unknown) => this.logger.warn(`session revoke failed after pw reset: ${String(e)}`));
    return { email: user.email };
  }

  // ---- helpers ----

  private async sendVerification(userId: string, email: string): Promise<void> {
    const token = await this.createToken(userId, AuthTokenType.EMAIL_VERIFY, EMAIL_VERIFY_TTL_MS);
    await this.mail.sendEmailVerification(email, token);
  }

  /** raw 토큰을 발급하고 sha256 해시만 저장. raw는 메일로만 전달. */
  private async createToken(userId: string, type: AuthTokenType, ttlMs: number): Promise<string> {
    const raw = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
    await this.prisma.authToken.create({
      data: { userId, type, tokenHash, expiresAt: new Date(Date.now() + ttlMs) },
    });
    return raw;
  }

  /** 토큰 검증 + 일회성 소비. 잘못/만료/사용됨/타입불일치 모두 동일 에러(열거 방지). */
  private async consumeToken(rawToken: string, type: AuthTokenType): Promise<string> {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    // 원자적 일회성 소비 — check-then-update는 동시 요청에서 이중 사용 가능.
    // usedAt IS NULL 조건부 갱신으로 단 한 요청만 count===1을 얻는다.
    const claimed = await this.prisma.authToken.updateMany({
      where: { tokenHash, type, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new DomainException(
        ErrorCode.INVALID_OR_EXPIRED_TOKEN,
        'Invalid or expired token',
        HttpStatus.BAD_REQUEST,
      );
    }
    const token = await this.prisma.authToken.findUnique({
      where: { tokenHash },
      select: { userId: true },
    });
    if (!token) {
      throw new DomainException(
        ErrorCode.INVALID_OR_EXPIRED_TOKEN,
        'Invalid or expired token',
        HttpStatus.BAD_REQUEST,
      );
    }
    return token.userId;
  }

  private async issueSession(user: UserRecord, ctx: LoginContext) {
    const sid = await this.sessions.create(user.id, ctx.ip, ctx.userAgent);
    const accessToken = this.jwt.sign({
      sub: user.id,
      email: user.email,
      role: user.role,
      sid,
    });
    return { accessToken, user: this.toProfile(user) };
  }

  /** 로그인 시도 기록 — best-effort(기록 실패가 인증 흐름을 깨지 않게). */
  private async recordLogin(userId: string, ctx: LoginContext, success: boolean): Promise<void> {
    await this.prisma.loginHistory
      .create({ data: { userId, ip: ctx.ip, userAgent: ctx.userAgent, success } })
      .catch((e: unknown) => this.logger.warn(`login history write failed: ${String(e)}`));
  }

  /** 이 IP에서 성공 로그인 이력이 없고, 다른 IP 성공 이력은 있으면 true(=새 IP 알림 대상). 첫 로그인은 known. */
  private async isNewIp(userId: string, ip: string): Promise<boolean> {
    const sameIp = await this.prisma.loginHistory.findFirst({
      where: { userId, ip, success: true },
      select: { id: true },
    });
    if (sameIp) return false;
    const anyPrior = await this.prisma.loginHistory.findFirst({
      where: { userId, success: true },
      select: { id: true },
    });
    return anyPrior !== null;
  }

  /** 만료 세션 lazy 정리 — 로그인 시점에 한 번(cron 미도입). best-effort. */
  private async cleanupExpiredSessions(userId: string): Promise<void> {
    await this.prisma.session
      .deleteMany({ where: { userId, expiresAt: { lt: new Date() } } })
      .catch(() => undefined);
  }

  private toProfile(user: UserRecord): UserProfile {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      antiPhishingCode: user.antiPhishingCode,
      role: user.role,
      createdAt: user.createdAt,
    };
  }
}
