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
import { JwtOnlyGuard } from '@app/core-domain/auth/guards/jwt-only.guard';
import { CreateApiKeyDto } from '../auth/api-keys/dto/create-api-key.dto';
import { SubaccountService } from './subaccount.service';
import { CreateSubaccountDto } from './dto/create-subaccount.dto';
import { SubaccountTransferDto } from './dto/subaccount-transfer.dto';

/**
 * 서브계정 관리. JWT 전용 — 마스터 세션으로만. 서브계정은 로그인 자격이 없고,
 * 마스터가 발급한 API 키로만 거래한다(에이전트 전용 계정).
 */
@ApiTags('subaccount')
@ApiBearerAuth()
@ApiCookieAuth('cookieAuth')
@UseGuards(JwtOnlyGuard)
@Controller('subaccounts')
export class SubaccountController {
  constructor(private readonly subaccountService: SubaccountService) {}

  @Post()
  @ApiOperation({ summary: 'Create a subaccount (API-only, owned by the current account)' })
  @ApiResponse({
    status: 201,
    description: 'Subaccount created; it inherits the master fee rates.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        id: 's1u2b3a4-c5c6-4d7e-8f90-1a2b3c4d5e6f',
        label: 'arb-bot-1',
        feeMakerBps: 10,
        feeTakerBps: 10,
        createdAt: '2026-06-15T09:00:00.000Z',
      },
    },
  })
  create(@CurrentUser() user: CurrentUserPayload, @Body() dto: CreateSubaccountDto) {
    return this.subaccountService.create(user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List the current account’s subaccounts' })
  @ApiResponse({
    status: 200,
    description: 'Subaccounts, newest first.',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          id: 's1u2b3a4-c5c6-4d7e-8f90-1a2b3c4d5e6f',
          label: 'arb-bot-1',
          feeMakerBps: 10,
          feeTakerBps: 10,
          createdAt: '2026-06-15T09:00:00.000Z',
        },
      ],
    },
  })
  list(@CurrentUser() user: CurrentUserPayload) {
    return this.subaccountService.list(user.userId);
  }

  @Post('transfers')
  @ApiOperation({ summary: 'Transfer balance between accounts (master↔sub, sub↔sub)' })
  @ApiResponse({
    status: 201,
    description: 'Transfer completed atomically between two accounts under the same master.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        transferId: 't1e2f3a4-b5c6-4d7e-8f90-1a2b3c4d5e6f',
        fromAccountId: 'm0000000-0000-0000-0000-000000000000',
        toAccountId: 's1u2b3a4-c5c6-4d7e-8f90-1a2b3c4d5e6f',
        assetSymbol: 'USDT',
        market: 'SPOT',
        qty: '100.00000000',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Insufficient balance, same source/destination, or pending futures settlement.',
    example: { code: 30002, message: 'Insufficient balance', data: null },
  })
  @ApiResponse({
    status: 404,
    description: 'An account is not the master or one of its subaccounts.',
    example: { code: 90001, message: 'Subaccount not found', data: null },
  })
  transfer(@CurrentUser() user: CurrentUserPayload, @Body() dto: SubaccountTransferDto) {
    return this.subaccountService.transfer(user.userId, dto);
  }

  @Get(':id/balances')
  @ApiOperation({ summary: 'Get a subaccount’s wallet balances' })
  @ApiParam({ name: 'id', type: String, description: 'Subaccount id (must be owned by the caller)' })
  @ApiResponse({
    status: 200,
    description: 'Wallet rows for the subaccount.',
    example: {
      code: 0,
      message: 'ok',
      data: [
        { assetSymbol: 'USDT', marketType: 'SPOT', balance: '100.00000000', locked: '0.00000000' },
      ],
    },
  })
  getBalances(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.subaccountService.getBalances(user.userId, id);
  }

  @Post(':id/api-keys')
  @ApiOperation({ summary: 'Issue an API key for a subaccount (secret returned once)' })
  @ApiParam({ name: 'id', type: String, description: 'Subaccount id (must be owned by the caller)' })
  @ApiResponse({
    status: 201,
    description: 'API key issued for the subaccount; the agent authenticates with it.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        apiKey: 'k3yAbC123XyZ_base64url',
        secret: 's3cr3tDeF456Uvw_base64url',
        label: 'arb-bot-1 key',
        canTrade: true,
        canRead: true,
        createdAt: '2026-06-15T09:00:00.000Z',
      },
    },
  })
  issueApiKey(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Body() dto: CreateApiKeyDto,
  ) {
    return this.subaccountService.issueApiKey(user.userId, id, dto);
  }

  @Get(':id/api-keys')
  @ApiOperation({ summary: 'List a subaccount’s active API keys (no secrets)' })
  @ApiParam({ name: 'id', type: String, description: 'Subaccount id (must be owned by the caller)' })
  @ApiResponse({ status: 200, description: 'Active (non-revoked) API keys for the subaccount.' })
  listApiKeys(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.subaccountService.listApiKeys(user.userId, id);
  }

  @Delete(':id/api-keys/:keyId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke a subaccount API key; idempotent' })
  @ApiParam({ name: 'id', type: String, description: 'Subaccount id (must be owned by the caller)' })
  @ApiParam({ name: 'keyId', type: String, description: 'API key id to revoke' })
  @ApiResponse({ status: 204, description: 'Revoked (no content).' })
  async revokeApiKey(
    @CurrentUser() user: CurrentUserPayload,
    @Param('id') id: string,
    @Param('keyId') keyId: string,
  ): Promise<void> {
    await this.subaccountService.revokeApiKey(user.userId, id, keyId);
  }
}
