import { Body, Controller, Get, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController, ApiSecurity } from '@nestjs/swagger';
import { MarketType } from '@prisma/client';
import { ServiceOrAdminGuard } from '@app/core-domain/auth/guards/service-or-admin.guard';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { AdminMarketService } from './admin-market.service';
import { CreateTickerDto } from './dto/create-ticker.dto';
import { SetTickerStatusDto } from './dto/set-ticker-status.dto';

function parseMarket(raw: string): MarketType {
  const m = raw.toUpperCase();
  if (m !== MarketType.SPOT && m !== MarketType.FUTURES)
    throw new DomainException(
      ErrorCode.INVALID_PARAMETER,
      `Invalid market: ${raw}`,
      HttpStatus.BAD_REQUEST,
    );
  return m;
}

/**
 * 상장 운영 API. 인증: 세션 admin 또는 `X-Admin-Secret`(스크립트/봇). 자금 이동 없음.
 */
@ApiExcludeController()
@ApiSecurity('adminSecret')
@UseGuards(ServiceOrAdminGuard)
@Controller('admin/tickers')
export class AdminMarketController {
  constructor(private readonly market: AdminMarketService) {}

  @Get()
  listTickers() {
    return this.market.listTickers();
  }

  @Post()
  createTicker(@Body() dto: CreateTickerDto) {
    return this.market.createTicker(dto);
  }

  @Patch(':market/:symbol/status')
  setTickerStatus(
    @Param('market') market: string,
    @Param('symbol') symbol: string,
    @Body() dto: SetTickerStatusDto,
  ) {
    return this.market.setTickerStatus(parseMarket(market), symbol.toUpperCase(), dto.status);
  }
}
