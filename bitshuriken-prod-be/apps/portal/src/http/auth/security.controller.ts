import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiExcludeController, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@app/shared/decorators/current-user.decorator';
import type { CurrentUserPayload } from '@app/shared/decorators/current-user.decorator';
import { AuthService } from '@app/core-domain/auth/auth.service';
import { SessionService } from '@app/core-domain/auth/session.service';
import { JwtOnlyGuard } from '@app/core-domain/auth/guards/jwt-only.guard';
import { AntiPhishingDto } from './dto/anti-phishing.dto';

/**
 * 계정 보안 관리 — 세션 목록/무효화, 로그인 이력, 안티피싱 코드. 웹 세션(JWT) 전용.
 */
@ApiExcludeController()
@ApiTags('auth/security')
@ApiCookieAuth('cookieAuth')
@UseGuards(JwtOnlyGuard)
@Controller('auth')
export class SecurityController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Get('sessions')
  @ApiOperation({ summary: 'List active sessions (current session flagged)' })
  @ApiResponse({ status: 200, description: 'Active sessions, most recently seen first.' })
  sessionList(@CurrentUser() user: CurrentUserPayload) {
    return this.sessions.list(user.userId, user.sessionId);
  }

  @Delete('sessions/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke one session by id' })
  @ApiResponse({ status: 200, example: { code: 0, message: 'ok', data: { ok: true } } })
  async revokeSession(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    await this.sessions.revoke(user.userId, id);
    return { ok: true };
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  @ApiOperation({ summary: 'Revoke every session except the current one' })
  @ApiResponse({ status: 200, example: { code: 0, message: 'ok', data: { ok: true } } })
  async revokeOthers(@CurrentUser() user: CurrentUserPayload) {
    if (user.sessionId) await this.sessions.revokeAllExcept(user.userId, user.sessionId);
    return { ok: true };
  }

  @Get('login-history')
  @ApiOperation({ summary: 'Recent login attempts (success + failure)' })
  @ApiResponse({ status: 200, description: 'Login history, newest first (up to 100).' })
  loginHistory(@CurrentUser() user: CurrentUserPayload) {
    return this.authService.getLoginHistory(user.userId);
  }

  @Post('anti-phishing')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set or clear the anti-phishing code (requires TOTP if 2FA enabled)' })
  @ApiResponse({ status: 200, description: 'Updated profile.' })
  setAntiPhishing(@CurrentUser() user: CurrentUserPayload, @Body() dto: AntiPhishingDto) {
    return this.authService.setAntiPhishingCode(user.userId, dto.code ?? null, dto.totpCode);
  }
}
