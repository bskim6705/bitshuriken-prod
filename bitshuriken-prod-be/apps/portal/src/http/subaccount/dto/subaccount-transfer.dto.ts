import { IsEnum, IsNotEmpty, IsNumberString, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MarketType } from '@prisma/client';

export class SubaccountTransferDto {
  @ApiProperty({ description: 'Source account id (master id or an owned subaccount id)' })
  @IsString()
  @IsNotEmpty()
  fromAccountId: string;

  @ApiProperty({ description: 'Destination account id (master id or an owned subaccount id)' })
  @IsString()
  @IsNotEmpty()
  toAccountId: string;

  @ApiProperty({ example: 'USDT' })
  @IsString()
  @IsNotEmpty()
  assetSymbol: string;

  @ApiPropertyOptional({
    enum: MarketType,
    default: MarketType.SPOT,
    description: 'Wallet venue moved on both sides (same market). Defaults to SPOT.',
  })
  @IsOptional()
  @IsEnum(MarketType)
  market?: MarketType;

  @ApiProperty({ example: '100.00000000' })
  @IsNumberString()
  qty: string;
}
