import { Body, Controller, Delete, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '@app/shared/decorators/current-user.decorator';
import type { CurrentUserPayload } from '@app/shared/decorators/current-user.decorator';
import { PrivateGuard } from '@app/core-domain/auth/guards/private.guard';
import { RequireApiScope, ApiScope } from '@app/shared/decorators/api-scope.decorator';
import { OrderCount } from '@app/shared/rate-limit/weight.decorator';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { FuturesTradingService } from './futures-trading.service';
import { CreateFuturesOrderDto } from './dto/create-futures-order.dto';
import { UpdatePositionDto } from './dto/update-position.dto';

@ApiTags('futures/trading')
@ApiSecurity('cookieAuth')
@ApiSecurity('apiKey')
@UseGuards(PrivateGuard)
@RequireApiScope(ApiScope.TRADE)
@Controller('futures/trading')
export class FuturesTradingController {
  constructor(private readonly tradingService: FuturesTradingService) {}

  @Post('orders')
  @OrderCount()
  @ApiOperation({ summary: 'Place futures order (LIMIT|MARKET|POST_ONLY) — returns NEW' })
  @ApiBody({ type: CreateFuturesOrderDto })
  @ApiResponse({
    status: 201,
    description: 'Order accepted; status NEW until the matching engine fills it.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        id: 'ord_8sf0a1',
        userId: 'usr_42',
        tickerSymbol: 'BTCUSDT',
        tickerMarket: 'FUTURES',
        type: 'LIMIT',
        side: 'BUY',
        timeInForce: 'GTC',
        price: '50000.00000000',
        origQty: '0.10000000',
        executedQty: '0.00000000',
        status: 'NEW',
        reduceOnly: false,
        createdAt: '2026-06-14T08:00:00.000Z',
      },
    },
  })
  placeOrder(@CurrentUser() user: CurrentUserPayload, @Body() dto: CreateFuturesOrderDto) {
    return this.tradingService.placeOrder(user.userId, dto);
  }

  @Delete('orders/:id')
  @ApiOperation({ summary: 'Cancel futures order (CO via engine, async)' })
  @ApiParam({
    name: 'id',
    type: String,
    required: true,
    description: 'Order id (uuid) or clientOrderId',
  })
  @ApiResponse({
    status: 200,
    description: 'Cancel request sent to the engine; returns the order snapshot at request time.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        id: 'ord_8sf0a1',
        tickerSymbol: 'BTCUSDT',
        tickerMarket: 'FUTURES',
        side: 'BUY',
        price: '50000.00000000',
        origQty: '0.10000000',
        executedQty: '0.00000000',
        status: 'OPEN',
      },
    },
  })
  cancelOrder(@CurrentUser() user: CurrentUserPayload, @Param('id') orderId: string) {
    return this.tradingService.cancelOrder(user.userId, orderId);
  }

  @Delete('open-orders')
  @ApiOperation({ summary: 'Cancel all open orders for a symbol (CO per order via engine, async)' })
  @ApiQuery({
    name: 'symbol',
    type: String,
    required: true,
    description: 'Symbol whose open orders should be canceled, e.g. BTCUSDT',
  })
  @ApiResponse({
    status: 200,
    description: 'Cancel requests sent for each open order; returns the targeted orders.',
    example: {
      code: 0,
      message: 'ok',
      data: [
        {
          id: 'ord_8sf0a1',
          tickerSymbol: 'BTCUSDT',
          side: 'BUY',
          price: '50000.00000000',
          origQty: '0.10000000',
          executedQty: '0.00000000',
          status: 'OPEN',
        },
      ],
    },
  })
  cancelOpenOrders(@CurrentUser() user: CurrentUserPayload, @Query('symbol') symbol?: string) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    return this.tradingService.cancelOpenOrders(user.userId, symbol);
  }

  @Patch('positions/:symbol')
  @ApiOperation({ summary: 'Set leverage (flat only) XOR adjust isolated margin' })
  @ApiParam({
    name: 'symbol',
    type: String,
    required: true,
    description: 'Symbol to update, e.g. BTCUSDT',
  })
  @ApiBody({ type: UpdatePositionDto })
  @ApiResponse({
    status: 200,
    description: 'Updated position row (leverage, margin mode and isolated margin).',
    example: {
      code: 0,
      message: 'ok',
      data: {
        userId: 'usr_42',
        tickerSymbol: 'BTCUSDT',
        tickerMarket: 'FUTURES',
        qty: '0.00000000',
        entryPrice: '0.00000000',
        isolatedMargin: '0.00000000',
        leverage: 20,
        marginMode: 'ISOLATED',
        status: 'NORMAL',
      },
    },
  })
  updatePosition(
    @CurrentUser() user: CurrentUserPayload,
    @Param('symbol') symbol: string,
    @Body() dto: UpdatePositionDto,
  ) {
    return this.tradingService.updatePosition(user.userId, symbol, dto);
  }
}
