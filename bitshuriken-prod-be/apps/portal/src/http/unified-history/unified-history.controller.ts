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
import { CurrentUser } from '@app/shared/decorators/current-user.decorator';
import type { CurrentUserPayload } from '@app/shared/decorators/current-user.decorator';
import { PrivateGuard } from '@app/core-domain/auth/guards/private.guard';
import { UnifiedHistoryService } from './unified-history.service';

const DEFAULT_LIMIT = 100;

@ApiTags('account/history')
@ApiBearerAuth()
@ApiCookieAuth('cookieAuth')
@ApiSecurity('apiKey')
@UseGuards(PrivateGuard)
@Controller('account')
export class UnifiedHistoryController {
  constructor(private readonly history: UnifiedHistoryService) {}

  @Get('history')
  @ApiOperation({
    summary:
      'Unified balance-change history (deposits/withdrawals/transfers + futures income + trades). type omitted = mixed feed.',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    description:
      'DEPOSIT|WITHDRAWAL|TRANSFER | REALIZED_PNL|COMMISSION|FUNDING_FEE|LIQUIDATION_FEE|INSURANCE_CLEAR | TRADE',
  })
  @ApiQuery({
    name: 'asset',
    required: false,
    description: 'Filter by asset/symbol prefix, e.g. BTC',
  })
  @ApiQuery({
    name: 'startTime',
    type: Number,
    required: false,
    description: 'Epoch ms range start',
  })
  @ApiQuery({ name: 'endTime', type: Number, required: false, description: 'Epoch ms range end' })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: 'Max rows (default 100, max 500)',
  })
  @ApiResponse({
    status: 200,
    description: 'Unified rows, newest first',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          id: 't1..',
          type: 'TRADE',
          asset: 'BTCUSDT',
          amount: '0.50000000',
          market: 'SPOT',
          time: 1718323200000,
          detail: { symbol: 'BTCUSDT', side: 'BUY', isMaker: false, price: '50000.00000000' },
        },
        {
          id: 'f1..',
          type: 'DEPOSIT',
          asset: 'USDT',
          amount: '1000.00000000',
          market: 'SPOT',
          time: 1718300000000,
          detail: { fromMarket: null, toMarket: 'SPOT', status: 'COMPLETED' },
        },
      ],
    },
  })
  list(
    @CurrentUser() user: CurrentUserPayload,
    @Query('limit', new DefaultValuePipe(DEFAULT_LIMIT), ParseIntPipe) limit: number,
    @Query('type') type?: string,
    @Query('asset') asset?: string,
    @Query('startTime', new ParseIntPipe({ optional: true })) startTime?: number,
    @Query('endTime', new ParseIntPipe({ optional: true })) endTime?: number,
  ) {
    return this.history.list(user.userId, { type, asset, startTime, endTime, limit });
  }
}
