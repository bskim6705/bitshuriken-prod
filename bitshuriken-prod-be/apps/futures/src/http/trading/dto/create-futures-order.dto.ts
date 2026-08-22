import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderSide, OrderType, TimeInForce } from '@prisma/client';
import { CLIENT_ORDER_ID_MESSAGE, CLIENT_ORDER_ID_PATTERN } from '@app/shared/order-client-id';

// stop류는 mark price 트리거까지 BE 보관 후 underlying(L/M)으로 엔진 전송
export const FUTURES_ORDER_TYPES = [
  OrderType.LIMIT,
  OrderType.MARKET,
  OrderType.POST_ONLY,
  OrderType.STOP_LOSS,
  OrderType.STOP_LOSS_LIMIT,
  OrderType.TAKE_PROFIT,
  OrderType.TAKE_PROFIT_LIMIT,
];

export class CreateFuturesOrderDto {
  @ApiProperty({ example: 'BTCUSDT' })
  @IsString()
  @IsNotEmpty()
  symbol: string;

  @ApiProperty({ enum: FUTURES_ORDER_TYPES })
  @IsIn(FUTURES_ORDER_TYPES)
  type: OrderType;

  @ApiProperty({ enum: OrderSide })
  @IsEnum(OrderSide)
  side: OrderSide;

  // LIMIT은 필수. MARKET은 IOC 고정, POST_ONLY는 GTC 고정 (다른 값 거부)
  @ApiPropertyOptional({ enum: TimeInForce })
  @IsOptional()
  @IsEnum(TimeInForce)
  timeInForce?: TimeInForce;

  @ApiPropertyOptional({ example: '50000.00000000' })
  @IsOptional()
  @IsNumberString()
  price?: string;

  // stop류 트리거 가격 (mark price 기준). STOP/TP 계열 필수, 그 외 금지
  @ApiPropertyOptional({ example: '49000.00000000', description: 'stop류 트리거 가격 (mark 기준)' })
  @IsOptional()
  @IsNumberString()
  stopPrice?: string;

  @ApiProperty({ example: '0.10000000', description: 'base qty (string, max 8dp)' })
  @IsNumberString()
  qty: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  reduceOnly?: boolean;

  // 클라이언트 지정 주문 id (미지정 시 BE 자동생성). 상품 내 유니크.
  @ApiPropertyOptional({
    example: 'my-order-1',
    maxLength: 36,
    description: CLIENT_ORDER_ID_MESSAGE,
  })
  @IsOptional()
  @IsString()
  @Matches(CLIENT_ORDER_ID_PATTERN, { message: CLIENT_ORDER_ID_MESSAGE })
  newClientOrderId?: string;
}
