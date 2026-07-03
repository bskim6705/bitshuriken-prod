import { IsEnum, IsNotEmpty, IsNumberString, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { MarketType } from '@prisma/client';

export class CreateTransferDto {
  @ApiProperty({ enum: MarketType, example: MarketType.SPOT })
  @IsEnum(MarketType)
  fromMarket: MarketType;

  @ApiProperty({ enum: MarketType, example: MarketType.FUTURES })
  @IsEnum(MarketType)
  toMarket: MarketType;

  @ApiProperty({ example: 'USDT' })
  @IsString()
  @IsNotEmpty()
  assetSymbol: string;

  @ApiProperty({ example: '1000.00000000' })
  @IsNumberString()
  qty: string;
}
