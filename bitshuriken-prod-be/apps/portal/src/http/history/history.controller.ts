import { Controller, DefaultValuePipe, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { FundingTxType } from '@prisma/client';
import { CurrentUser } from '@app/shared/decorators/current-user.decorator';
import type { CurrentUserPayload } from '@app/shared/decorators/current-user.decorator';
import { PrivateGuard } from '@app/core-domain/auth/guards/private.guard';
import { HistoryService } from './history.service';

const DEFAULT_LIMIT = 100;

@ApiTags('account/history')
@ApiBearerAuth()
@ApiCookieAuth('cookieAuth')
@ApiSecurity('apiKey')
@UseGuards(PrivateGuard)
@Controller('account')
export class HistoryController {
  constructor(private readonly historyService: HistoryService) {}

  @Get('transactions')
  @ApiOperation({
    summary: 'Funding ledger: deposits, withdrawals, and internal transfers (newest first)',
  })
  @ApiQuery({
    name: 'type',
    enum: FundingTxType,
    required: false,
    description: 'Filter by transaction type',
  })
  @ApiQuery({
    name: 'asset',
    type: String,
    required: false,
    description: 'Filter by asset symbol e.g. USDT',
  })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: 'Max rows (default 100, max 500)',
  })
  @ApiQuery({
    name: 'endTime',
    type: Number,
    required: false,
    description: 'Epoch ms cursor; return rows at or before this time',
  })
  @ApiResponse({
    status: 200,
    description: 'Funding transactions, newest first',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          id: 'f1e2d3c4-...',
          type: 'TRANSFER',
          assetSymbol: 'USDT',
          qty: '1000.00000000',
          fromMarket: 'SPOT',
          toMarket: 'FUTURES',
          status: 'COMPLETED',
          time: 1718000000000,
        },
      ],
    },
  })
  listTransactions(
    @CurrentUser() user: CurrentUserPayload,
    @Query('limit', new DefaultValuePipe(DEFAULT_LIMIT), ParseIntPipe) limit: number,
    @Query('type') type?: string,
    @Query('asset') asset?: string,
    @Query('endTime', new ParseIntPipe({ optional: true })) endTime?: number,
  ) {
    return this.historyService.listTransactions(user.userId, { type, asset, limit, endTime });
  }
}
