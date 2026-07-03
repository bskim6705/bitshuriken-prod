import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '@app/shared/decorators/current-user.decorator';
import type { CurrentUserPayload } from '@app/shared/decorators/current-user.decorator';
import { ApiKeyService } from '@app/core-domain/api-key/api-key.service';
import { JwtOnlyGuard } from '@app/core-domain/auth/guards/jwt-only.guard';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

/**
 * API key 관리. JWT 전용 — API key로 새 API key를 발급하는 escalation 차단.
 */
@ApiTags('auth/api-keys')
@ApiBearerAuth()
@ApiCookieAuth('cookieAuth')
@UseGuards(JwtOnlyGuard)
@Controller('auth/api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @Post()
  @ApiOperation({ summary: 'Issue a new API key (plaintext secret returned once)' })
  @ApiResponse({
    status: 201,
    description: 'API key issued; secret is returned only on this response.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        apiKey: 'k3yAbC123XyZ_base64url',
        secret: 's3cr3tDeF456Uvw_base64url',
        label: 'trading bot 1',
        canTrade: false,
        canRead: true,
        createdAt: '2026-06-13T09:00:00.000Z',
      },
    },
  })
  issue(@CurrentUser() user: CurrentUserPayload, @Body() dto: CreateApiKeyDto) {
    return this.apiKeyService.issue(user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: "List the current user's active API keys (no secrets)" })
  @ApiResponse({
    status: 200,
    description: 'Active (non-revoked) API keys, newest first.',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
          apiKey: 'k3yAbC123XyZ_base64url',
          label: 'trading bot 1',
          canTrade: false,
          canRead: true,
          ipWhitelist: [],
          createdAt: '2026-06-13T09:00:00.000Z',
          lastUsedAt: null,
        },
      ],
    },
  })
  list(@CurrentUser() user: CurrentUserPayload) {
    return this.apiKeyService.listForUser(user.userId);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke (soft-delete) an API key; idempotent' })
  @ApiParam({
    name: 'id',
    type: String,
    required: true,
    description: 'API key id (uuid) to revoke. Must belong to the current user.',
  })
  @ApiResponse({ status: 204, description: 'Revoked (no content).' })
  @ApiResponse({
    status: 404,
    description: 'API key not found.',
    example: { code: 1101, message: 'API key not found', data: null },
  })
  async revoke(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') apiKeyId: string,
  ): Promise<void> {
    await this.apiKeyService.revoke(user.userId, apiKeyId);
  }
}
