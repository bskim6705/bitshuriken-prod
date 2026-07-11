import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiSecurity } from '@nestjs/swagger';
import { ServiceOrAdminGuard } from '@app/core-domain/auth/guards/service-or-admin.guard';
import { AdminService } from './admin.service';
import { SetRateLimitExemptDto } from './dto/set-rate-limit-exempt.dto';

/**
 * 운영 스크립트/봇용 admin API. 인증: 세션 admin 또는 `X-Admin-Secret` (ServiceOrAdminGuard).
 * 자금 이동 없음 — 계정 플래그만. 시장 조성 봇이 부팅 시 자기 계정을 면제 처리하는 데 쓴다 (ADR-066).
 */
@ApiExcludeController()
@ApiSecurity('adminSecret')
@UseGuards(ServiceOrAdminGuard)
@Controller('admin/users')
export class AdminOpsController {
  constructor(private readonly admin: AdminService) {}

  @Post(':userId/rate-limit-exempt')
  setRateLimitExempt(@Param('userId') userId: string, @Body() dto: SetRateLimitExemptDto) {
    return this.admin.setRateLimitExempt(userId, dto.exempt);
  }
}
