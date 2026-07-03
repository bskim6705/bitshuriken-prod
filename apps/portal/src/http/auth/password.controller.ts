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
import { AuthService } from '@app/core-domain/auth/auth.service';
import { JwtOnlyGuard } from '@app/core-domain/auth/guards/jwt-only.guard';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

// Excluded from the API reference: website-only account management (Binance parity).
@ApiExcludeController()
@ApiTags('auth/password')
@Controller('auth/password')
export class PasswordController {
  constructor(private readonly authService: AuthService) {}

  @Post('forgot')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Request a password reset email (always returns ok — no account enumeration)',
  })
  @ApiResponse({ status: 200, example: { code: 0, message: 'ok', data: { ok: true } } })
  async forgot(@Body() dto: ForgotPasswordDto) {
    await this.authService.forgotPassword(dto.email);
    return { ok: true };
  }

  @Post('reset')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reset password using the token from the email' })
  @ApiResponse({ status: 200, example: { code: 0, message: 'ok', data: { ok: true } } })
  async reset(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto.token, dto.password);
    return { ok: true };
  }

  @Post('change')
  @HttpCode(200)
  @UseGuards(JwtOnlyGuard)
  @ApiCookieAuth('cookieAuth')
  @ApiOperation({ summary: 'Change password (requires current password; web session only)' })
  @ApiResponse({ status: 200, example: { code: 0, message: 'ok', data: { ok: true } } })
  async change(@CurrentUser() user: CurrentUserPayload, @Body() dto: ChangePasswordDto) {
    await this.authService.changePassword(user.userId, dto.oldPassword, dto.newPassword);
    return { ok: true };
  }
}
