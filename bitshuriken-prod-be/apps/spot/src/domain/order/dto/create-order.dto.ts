import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsNumberString,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MarketType, OrderSide, OrderType, TimeInForce } from '@prisma/client';
import { CLIENT_ORDER_ID_MESSAGE, CLIENT_ORDER_ID_PATTERN } from '@app/shared/order-client-id';

export class CreateOrderDto {
  @ApiProperty({ example: 'BTCUSDT' })
  @IsString()
  @IsNotEmpty()
  tickerSymbol: string;

  @ApiProperty({ enum: MarketType })
  @IsEnum(MarketType)
  tickerMarket: MarketType;

  @ApiProperty({ enum: OrderType })
  @IsEnum(OrderType)
  type: OrderType;

  @ApiProperty({ enum: OrderSide })
  @IsEnum(OrderSide)
  side: OrderSide;

  @ApiProperty({ enum: TimeInForce })
  @IsEnum(TimeInForce)
  timeInForce: TimeInForce;

  // limit-like 전용
  @ApiPropertyOptional({ example: '50000.00000000' })
  @IsOptional()
  @IsNumberString()
  price?: string;

  // stop 계열 전용 트리거 가격
  @ApiPropertyOptional({ example: '48000.00000000' })
  @IsOptional()
  @IsNumberString()
  stopPrice?: string;

  // limit-like, market-like SELL: base 단위 수량
  @ApiPropertyOptional({ example: '0.10000000' })
  @IsOptional()
  @IsNumberString()
  origQty?: string;

  // market-like BUY 전용: quote 단위 수량
  @ApiPropertyOptional({ example: '5000.00000000' })
  @IsOptional()
  @IsNumberString()
  origQuoteQty?: string;

  // cancel-replace: 신규 배치 후 기존 주문 취소 (비원자 — 잠금 일시 공존)
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  replacesOrderId?: string;

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
