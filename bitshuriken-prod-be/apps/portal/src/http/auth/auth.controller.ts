import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiExcludeController,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthService } from '@app/core-domain/auth/auth.service';
import type { LoginContext } from '@app/core-domain/auth/auth.service';
import { AuthSessionService } from '@app/core-domain/auth/auth-session.service';
import { SignupDto } from '@app/core-domain/auth/dto/signup.dto';
import { LoginDto } from '@app/core-domain/auth/dto/login.dto';
import { JwtOnlyGuard } from '@app/core-domain/auth/guards/jwt-only.guard';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { SecurityNotifyService } from '../../notify/security-notify.service';

function loginContext(req: Request): LoginContext {
  return { ip: req.ip ?? 'unknown', userAgent: req.header('user-agent') ?? null };
}

// Excluded from the API reference: website session / account-management flows
// (signup/login/2FA/etc.) are not part of the programmatic API (Binance parity).
@ApiExcludeController()
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly session: AuthSessionService,
    private readonly notify: SecurityNotifyService,
  ) {}

  @Post('signup')
  @ApiOperation({ summary: 'Register a new user and start a session (sets bs_session cookie)' })
  @ApiResponse({
    status: 201,
    description: 'User created; session cookie set.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        id: '7c3f8a10-2b4e-4d8a-9f1c-6d2e0b5a1c33',
        email: 'alice@test.com',
        createdAt: '2026-06-13T09:00:00.000Z',
      },
    },
  })
  async signup(
    @Body() dto: SignupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { accessToken, user } = await this.authService.signup(dto, loginContext(req));
    this.session.setSession(res, accessToken);
    return user;
  }

  @Post('login')
  @ApiOperation({ summary: 'Authenticate with email/password and start a session' })
  @ApiResponse({
    status: 201,
    description: 'Authenticated; session cookie set.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        id: '7c3f8a10-2b4e-4d8a-9f1c-6d2e0b5a1c33',
        email: 'alice@test.com',
        createdAt: '2026-06-13T09:00:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Invalid credentials.',
    example: { code: 1002, message: 'Invalid credentials', data: null },
  })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ctx = loginContext(req);
    const { accessToken, user, newIp } = await this.authService.login(dto, ctx);
    this.session.setSession(res, accessToken);
    if (newIp) this.notify.loginAlert(user.email, ctx.ip, ctx.userAgent);
    return user;
  }

  @Post('verify-email')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify email using the token from the verification email' })
  @ApiResponse({ status: 200, example: { code: 0, message: 'ok', data: { ok: true } } })
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    await this.authService.verifyEmail(dto.token);
    return { ok: true };
  }

  @Post('verify-email/resend')
  @HttpCode(200)
  @UseGuards(JwtOnlyGuard)
  @ApiCookieAuth('cookieAuth')
  @ApiOperation({ summary: 'Resend the email verification link to the current user' })
  @ApiResponse({ status: 200, example: { code: 0, message: 'ok', data: { ok: true } } })
  async resendVerification(@Req() req: Request) {
    const { userId } = req.user as { userId: string; email: string };
    await this.authService.resendVerification(userId);
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Clear the session cookie' })
  @ApiResponse({
    status: 200,
    description: 'Session cleared.',
    example: { code: 0, message: 'ok', data: { ok: true } },
  })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // 서버측 세션도 revoke — best-effort(토큰 만료/부재여도 쿠키는 항상 정리).
    await this.authService.logout(this.session.extractToken(req));
    this.session.clearSession(res);
    return { ok: true };
  }

  @Get('me')
  @UseGuards(JwtOnlyGuard)
  @ApiCookieAuth('cookieAuth')
  @ApiOperation({ summary: 'Get the current authenticated user profile (cookie/Bearer only)' })
  @ApiResponse({
    status: 200,
    description: 'Current user profile.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        id: '7c3f8a10-2b4e-4d8a-9f1c-6d2e0b5a1c33',
        email: 'alice@test.com',
        createdAt: '2026-06-13T09:00:00.000Z',
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid session.',
    example: { code: 1003, message: 'User not found', data: null },
  })
  me(@Req() req: Request) {
    const { userId } = req.user as { userId: string; email: string };
    return this.authService.getProfile(userId);
  }

  @Patch('profile')
  @UseGuards(JwtOnlyGuard)
  @ApiCookieAuth('cookieAuth')
  @ApiOperation({ summary: 'Update profile (leaderboard display name)' })
  @ApiResponse({
    status: 200,
    description: 'Updated profile.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        id: '7c3f8a10-2b4e-4d8a-9f1c-6d2e0b5a1c33',
        email: 'alice@test.com',
        displayName: 'alpha-bot',
        emailVerified: true,
        twoFactorEnabled: false,
        createdAt: '2026-06-13T09:00:00.000Z',
      },
    },
  })
  updateProfile(@Req() req: Request, @Body() dto: UpdateProfileDto) {
    const { userId } = req.user as { userId: string; email: string };
    return this.authService.updateDisplayName(userId, dto.displayName ?? null);
  }
}
