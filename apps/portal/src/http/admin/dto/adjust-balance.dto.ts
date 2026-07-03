import {
  IsEnum,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { MarketType } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AdjustBalanceDto {
  @ApiProperty({ enum: MarketType, example: 'SPOT' })
  @IsEnum(MarketType)
  marketType: MarketType;

  @ApiProperty({ example: 'USDT' })
  @IsString()
  @IsNotEmpty()
  assetSymbol: string;

  @ApiProperty({ example: '1000.00000000' })
  @IsNumberString()
  qty: string;

  @ApiPropertyOptional({ example: 'manual correction for incident #123' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @ApiPropertyOptional({
    example: '123456',
    description: '6-digit TOTP of the acting admin (required if the admin has 2FA enabled)',
  })
  @IsOptional()
  @IsString()
  totpCode?: string;
}
