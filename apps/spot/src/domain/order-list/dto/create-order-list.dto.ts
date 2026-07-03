import { IsEnum, IsNotEmpty, IsNumberString, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MarketType, OrderSide, TimeInForce } from '@prisma/client';

export class CreateOrderListDto {
  @ApiProperty({ example: 'BTCUSDT' })
  @IsString()
  @IsNotEmpty()
  tickerSymbol: string;

  @ApiProperty({ enum: MarketType })
  @IsEnum(MarketType)
  tickerMarket: MarketType;

  @ApiProperty({ enum: OrderSide })
  @IsEnum(OrderSide)
  side: OrderSide;

  // 양 레그 공통 base 수량
  @ApiProperty({ example: '0.10000000' })
  @IsNumberString()
  qty: string;

  // limit 레그 가격
  @ApiProperty({ example: '52000.00' })
  @IsNumberString()
  price: string;

  // stop 레그 트리거 가격
  @ApiProperty({ example: '48000.00' })
  @IsNumberString()
  stopPrice: string;

  // stop 레그(STOP_LOSS_LIMIT) limit 가격
  @ApiProperty({ example: '47900.00' })
  @IsNumberString()
  stopLimitPrice: string;

  @ApiProperty({ enum: TimeInForce })
  @IsEnum(TimeInForce)
  stopLimitTimeInForce: TimeInForce;
}
