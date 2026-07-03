import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  Query,
  UseGuards,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiBearerAuth,
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
import { MarketType } from '@prisma/client';
import { OrderService } from '../../../../domain/order/order.service';
import { CreateOrderDto } from '../../../../domain/order/dto/create-order.dto';
import { OrderListService } from '../../../../domain/order-list/order-list.service';
import { CreateOrderListDto } from '../../../../domain/order-list/dto/create-order-list.dto';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

@ApiTags('spot/trading')
@ApiBearerAuth()
@ApiSecurity('cookieAuth')
@ApiSecurity('apiKey')
@UseGuards(PrivateGuard)
@RequireApiScope(ApiScope.TRADE)
@Controller('spot/trading')
export class TradingController {
  constructor(
    private readonly orderService: OrderService,
    private readonly orderListService: OrderListService,
  ) {}

  @Post('orders')
  @OrderCount()
  @ApiOperation({
    summary: 'Place order (7 types). replacesOrderId → cancel-replace (non-atomic)',
  })
  @ApiResponse({
    status: 201,
    description: 'Accepted order; cancel-replace also returns the replaced order id',
    example: {
      code: 0,
      message: 'ok',
      data: {
        id: '7b2c1a9e-...',
        tickerSymbol: 'BTCUSDT',
        tickerMarket: 'SPOT',
        side: 'BUY',
        type: 'LIMIT',
        timeInForce: 'GTC',
        price: '50000.00',
        origQty: '0.10000000',
        executedQty: '0.00000000',
        cumulativeQuoteQty: '0.00000000',
        status: 'NEW',
        createdAt: '2026-06-14T00:00:00.000Z',
      },
    },
  })
  submitNewOrder(@CurrentUser() user: CurrentUserPayload, @Body() dto: CreateOrderDto) {
    // spot 경로는 SPOT 전용 — FUTURES 주문이 spot 잠금/정산으로 새는 것 차단
    if (dto.tickerMarket !== MarketType.SPOT) {
      throw new DomainException(ErrorCode.INVALID_PARAMETER, 'tickerMarket must be SPOT');
    }
    return this.orderService.submitNewOrder(user.userId, dto);
  }

  @Delete('orders/:id')
  @ApiOperation({
    summary: 'Cancel order (untriggered stop → local cancel, OCO leg → list cancel)',
  })
  @ApiParam({ name: 'id', type: String, description: 'Order id (uuid) or clientOrderId' })
  @ApiResponse({
    status: 200,
    description: 'Cancel requested; order transitions to PENDING_CANCEL / CANCELED',
    example: {
      code: 0,
      message: 'ok',
      data: {
        id: '7b2c1a9e-...',
        tickerSymbol: 'BTCUSDT',
        tickerMarket: 'SPOT',
        status: 'PENDING_CANCEL',
      },
    },
  })
  async submitCancelOrder(@CurrentUser() user: CurrentUserPayload, @Param('id') orderId: string) {
    // spot 경로는 SPOT 전용 — FUTURES 주문 CO가 이 경로로 새는 것 차단
    const order = await this.orderService.findOneForUser(user.userId, orderId);
    if (order.tickerMarket !== MarketType.SPOT) {
      throw new DomainException(ErrorCode.ORDER_NOT_FOUND, 'Order not found', HttpStatus.NOT_FOUND);
    }
    return this.orderService.submitCancelOrder(user.userId, orderId);
  }

  @Delete('open-orders')
  @ApiOperation({ summary: 'Cancel all open orders for a symbol (symbol required)' })
  @ApiQuery({ name: 'symbol', type: String, required: true, description: 'e.g. BTCUSDT' })
  cancelAllOpen(@CurrentUser() user: CurrentUserPayload, @Query('symbol') symbol?: string) {
    if (!symbol) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'symbol is required');
    return this.orderService.cancelAllOpen(user.userId, MarketType.SPOT, symbol);
  }

  @Post('order-lists')
  @OrderCount(2)
  @ApiOperation({ summary: 'Place OCO order list (LIMIT leg + STOP_LOSS_LIMIT leg)' })
  createOrderList(@CurrentUser() user: CurrentUserPayload, @Body() dto: CreateOrderListDto) {
    if (dto.tickerMarket !== MarketType.SPOT) {
      throw new DomainException(ErrorCode.INVALID_PARAMETER, 'tickerMarket must be SPOT');
    }
    return this.orderListService.createOcoList(user.userId, dto);
  }

  @Delete('order-lists/:id')
  @ApiOperation({ summary: 'Cancel OCO order list' })
  @ApiParam({ name: 'id', type: String, description: 'Order list id (uuid)' })
  cancelOrderList(@CurrentUser() user: CurrentUserPayload, @Param('id') listId: string) {
    return this.orderListService.cancelList(user.userId, listId);
  }
}
