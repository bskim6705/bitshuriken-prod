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

const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1h

export interface UserProfile {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  role: UserRole;
  createdAt: Date;
}

interface UserRecord {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  role: UserRole;
  createdAt: Date;
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
  ) {}

  async signup(dto: SignupDto) {
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

    return this.issueSession(user);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user)
      throw new DomainException(
        ErrorCode.INVALID_CREDENTIALS,
        'Invalid credentials',
        HttpStatus.UNAUTHORIZED,
      );

    const valid = await bcrypt.compare(dto.password, user.hashedPassword);
    if (!valid)
      throw new DomainException(
        ErrorCode.INVALID_CREDENTIALS,
        'Invalid credentials',
        HttpStatus.UNAUTHORIZED,
      );

    // 2FA 사용자는 TOTP 코드 필수 (미사용자는 no-op → 기존 흐름 불변)
    this.twoFactor.assertForUser(user, dto.totpCode);

    // 계정 정지 — 자격 확인 후 차단 (잘못된 비번엔 상태 비노출)
    if (!user.loginEnabled)
      throw new DomainException(
        ErrorCode.ACCOUNT_LOGIN_DISABLED,
        'Sign-in is disabled for this account',
        HttpStatus.FORBIDDEN,
      );

    return this.issueSession(user);
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

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
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
    await this.prisma.user.update({
      where: { id: userId },
      data: { hashedPassword: await bcrypt.hash(newPassword, 10) },
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

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    const userId = await this.consumeToken(rawToken, AuthTokenType.PASSWORD_RESET);
    await this.prisma.user.update({
      where: { id: userId },
      data: { hashedPassword: await bcrypt.hash(newPassword, 10) },
    });
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

  private issueSession(user: UserRecord) {
    const accessToken = this.jwt.sign({ sub: user.id, email: user.email, role: user.role });
    return { accessToken, user: this.toProfile(user) };
  }

  private toProfile(user: UserRecord): UserProfile {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      role: user.role,
      createdAt: user.createdAt,
    };
  }
}
