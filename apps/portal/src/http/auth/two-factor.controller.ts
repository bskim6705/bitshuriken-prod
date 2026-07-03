import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiExcludeController,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '@app/shared/decorators/current-user.decorator';
import type { CurrentUserPayload } from '@app/shared/decorators/current-user.decorator';
import { TwoFactorService } from '@app/core-domain/two-factor/two-factor.service';
import { JwtOnlyGuard } from '@app/core-domain/auth/guards/jwt-only.guard';
import { TwoFactorCodeDto } from './dto/two-factor-code.dto';

/**
 * TOTP 2FA 관리. 웹 세션(JWT) 전용 — API key로 2FA를 켜고 끄는 escalation 차단.
 */
// Excluded from the API reference: website-only account management (Binance parity).
@ApiExcludeController()
@ApiTags('auth/2fa')
@ApiCookieAuth('cookieAuth')
@UseGuards(JwtOnlyGuard)
@Controller('auth/2fa')
export class TwoFactorController {
  constructor(private readonly twoFactor: TwoFactorService) {}

  @Post('setup')
  @ApiOperation({ summary: 'Begin 2FA setup — returns otpauth URI + QR (secret shown once)' })
  @ApiResponse({
    status: 201,
    description: 'Scan the QR in an authenticator app, then call enable with a code.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        secret: 'JBSWY3DPEHPK3PXP',
        otpauthUrl: 'otpauth://totp/Bitshuriken:alice@test.com?secret=...&issuer=Bitshuriken',
        qrDataUrl: 'data:image/png;base64,iVBORw0KGgo...',
      },
    },
  })
  setup(@CurrentUser() user: CurrentUserPayload) {
    return this.twoFactor.setup(user.userId, user.email);
  }

  @Post('enable')
  @HttpCode(200)
  @ApiOperation({ summary: 'Confirm and enable 2FA with a code from the authenticator app' })
  @ApiResponse({ status: 200, example: { code: 0, message: 'ok', data: { ok: true } } })
  async enable(@CurrentUser() user: CurrentUserPayload, @Body() dto: TwoFactorCodeDto) {
    await this.twoFactor.enable(user.userId, dto.code);
    return { ok: true };
  }

  @Post('disable')
  @HttpCode(200)
  @ApiOperation({ summary: 'Disable 2FA (requires a valid current code)' })
  @ApiResponse({ status: 200, example: { code: 0, message: 'ok', data: { ok: true } } })
  async disable(@CurrentUser() user: CurrentUserPayload, @Body() dto: TwoFactorCodeDto) {
    await this.twoFactor.disable(user.userId, dto.code);
    return { ok: true };
  }
}
