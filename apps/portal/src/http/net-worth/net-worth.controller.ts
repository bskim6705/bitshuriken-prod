import { Controller, Get, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
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
import { NetWorthService } from './net-worth.service';

@ApiTags('account/net-worth')
@ApiBearerAuth()
@ApiCookieAuth('cookieAuth')
@ApiSecurity('apiKey')
@UseGuards(PrivateGuard)
@Controller('account')
export class NetWorthController {
  constructor(private readonly netWorth: NetWorthService) {}

  @Get('net-worth')
  @ApiOperation({
    summary: 'Daily net-worth (estimated balance) series — total + spot/futures split + breakdown',
  })
  @ApiQuery({
    name: 'from',
    type: Number,
    required: false,
    description: 'Epoch ms (default 30d ago)',
  })
  @ApiQuery({ name: 'to', type: Number, required: false, description: 'Epoch ms (default now)' })
  @ApiResponse({
    status: 200,
    description: 'Daily snapshots, oldest first',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          day: '2026-06-14',
          time: 1718323200000,
          totalUsdt: '78000.00000000',
          spotUsdt: '76000.00000000',
          futuresUsdt: '2000.00000000',
          breakdown: [
            { market: 'SPOT', asset: 'BTC', qty: '1.50000000', valueUsdt: '75000.00000000' },
          ],
        },
      ],
    },
  })
  series(
    @CurrentUser() user: CurrentUserPayload,
    @Query('from', new ParseIntPipe({ optional: true })) from?: number,
    @Query('to', new ParseIntPipe({ optional: true })) to?: number,
  ) {
    return this.netWorth.series(user.userId, { from, to });
  }
}
