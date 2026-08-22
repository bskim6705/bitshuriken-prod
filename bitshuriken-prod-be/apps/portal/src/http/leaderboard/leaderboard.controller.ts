import { Controller, Get, ParseIntPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { LeaderboardService } from './leaderboard.service';

@ApiTags('leaderboard')
@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboard: LeaderboardService) {}

  @Get()
  @ApiOperation({
    summary: 'Public trading leaderboard — ROI% / PnL / volume ranking over a time window',
  })
  @ApiQuery({
    name: 'window',
    required: false,
    description: 'DAILY|WEEKLY|MONTHLY|ALL (default WEEKLY)',
  })
  @ApiQuery({ name: 'metric', required: false, description: 'ROI|PNL|VOLUME (default ROI)' })
  @ApiQuery({
    name: 'limit',
    type: Number,
    required: false,
    description: 'Max rows (default 100, max 200)',
  })
  @ApiResponse({
    status: 200,
    description: 'Ranked rows for the chosen metric',
    example: {
      code: 0,
      message: 'ok',
      data: {
        window: 'WEEKLY',
        metric: 'ROI',
        rows: [
          {
            rank: 1,
            userId: '7c3f8a10-2b4e-4d8a-9f1c-6d2e0b5a1c33',
            name: 'alpha-bot',
            roi: '142.34',
            pnl: '14234.00000000',
            volume: '2104500.00000000',
            startEquity: '10000.00000000',
            endEquity: '24234.00000000',
          },
        ],
      },
    },
  })
  list(
    @Query('window') window?: string,
    @Query('metric') metric?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.leaderboard.list({ window, metric, limit });
  }
}
