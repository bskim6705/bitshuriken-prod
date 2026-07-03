import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiExcludeController } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '@app/shared/decorators/current-user.decorator';
import type { CurrentUserPayload } from '@app/shared/decorators/current-user.decorator';
import { JwtOnlyGuard } from '@app/core-domain/auth/guards/jwt-only.guard';
import { AdminGuard } from '@app/core-domain/auth/guards/admin.guard';
import { Roles } from '@app/shared/decorators/roles.decorator';
import { AdminService } from './admin.service';
import { AdjustBalanceDto } from './dto/adjust-balance.dto';
import { UpdateFeeDto } from './dto/update-fee.dto';
import { StepUpDto } from './dto/step-up.dto';
import { SetRoleDto } from './dto/set-role.dto';
import { SetRestrictionsDto } from './dto/set-restrictions.dto';

// 내부 운영 API (유저/자금) — 공개 레퍼런스 제외. JWT 세션 전용(API key escalation 차단) + 위험작업 2FA.
@ApiExcludeController()
@ApiBearerAuth()
@ApiCookieAuth('cookieAuth')
@UseGuards(JwtOnlyGuard, AdminGuard)
@Roles(UserRole.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('users')
  listUsers(
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('search') search?: string,
  ) {
    return this.adminService.listUsers({ search, limit, offset });
  }

  @Get('users/:userId')
  getUser(@Param('userId') userId: string) {
    return this.adminService.getUser(userId);
  }

  @Post('users/:userId/balance/credit')
  creditBalance(
    @CurrentUser() admin: CurrentUserPayload,
    @Param('userId') userId: string,
    @Body() dto: AdjustBalanceDto,
  ) {
    return this.adminService.adjustBalance(admin.userId, userId, dto, 'credit');
  }

  @Post('users/:userId/balance/debit')
  debitBalance(
    @CurrentUser() admin: CurrentUserPayload,
    @Param('userId') userId: string,
    @Body() dto: AdjustBalanceDto,
  ) {
    return this.adminService.adjustBalance(admin.userId, userId, dto, 'debit');
  }

  @Patch('users/:userId/fee')
  updateFee(
    @CurrentUser() admin: CurrentUserPayload,
    @Param('userId') userId: string,
    @Body() dto: UpdateFeeDto,
  ) {
    return this.adminService.updateFee(admin.userId, userId, dto);
  }

  @Post('api-keys/:apiKeyId/revoke')
  revokeApiKey(
    @CurrentUser() admin: CurrentUserPayload,
    @Param('apiKeyId') apiKeyId: string,
    @Body() dto: StepUpDto,
  ) {
    return this.adminService.revokeApiKey(admin.userId, apiKeyId, dto.totpCode);
  }

  @Get('overview')
  getOverview() {
    return this.adminService.getOverview();
  }

  @Patch('users/:userId/role')
  setRole(
    @CurrentUser() admin: CurrentUserPayload,
    @Param('userId') userId: string,
    @Body() dto: SetRoleDto,
  ) {
    return this.adminService.setRole(admin.userId, userId, dto);
  }

  @Post('users/:userId/reset-2fa')
  resetTwoFactor(
    @CurrentUser() admin: CurrentUserPayload,
    @Param('userId') userId: string,
    @Body() dto: StepUpDto,
  ) {
    return this.adminService.resetTwoFactor(admin.userId, userId, dto.totpCode);
  }

  @Post('users/:userId/verify-email')
  verifyEmail(
    @CurrentUser() admin: CurrentUserPayload,
    @Param('userId') userId: string,
    @Body() dto: StepUpDto,
  ) {
    return this.adminService.forceVerifyEmail(admin.userId, userId, dto.totpCode);
  }

  @Patch('users/:userId/restrictions')
  setRestrictions(
    @CurrentUser() admin: CurrentUserPayload,
    @Param('userId') userId: string,
    @Body() dto: SetRestrictionsDto,
  ) {
    return this.adminService.setRestrictions(admin.userId, userId, dto);
  }
}
