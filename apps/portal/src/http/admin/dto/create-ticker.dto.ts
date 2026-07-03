import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { MarketType, TickerStatus } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTickerDto {
  @ApiProperty({ enum: MarketType, example: 'SPOT' })
  @IsEnum(MarketType)
  market: MarketType;

  @ApiProperty({ example: 'BTC1', description: 'Base asset symbol (created if missing)' })
  @IsString()
  @IsNotEmpty()
  baseAsset: string;

  @ApiProperty({ example: 'USDT' })
  @IsString()
  @IsNotEmpty()
  quoteAsset: string;

  @ApiPropertyOptional({ example: 'BTC1USDT', description: 'Defaults to baseAsset+quoteAsset' })
  @IsOptional()
  @IsString()
  symbol?: string;

  @ApiProperty({ example: 2, description: 'pricePrecision + qtyPrecision must be <= 8' })
  @IsInt()
  @Min(0)
  @Max(8)
  pricePrecision: number;

  @ApiProperty({ example: 5 })
  @IsInt()
  @Min(0)
  @Max(8)
  qtyPrecision: number;

  @ApiPropertyOptional({
    description: 'Kafka partition bucket = FNV-1a(symbol)%P; auto-derived if omitted, must equal that if provided',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  partition?: number;

  @ApiPropertyOptional({ example: '5', description: 'Defaults: 5 for USDT/USDC quote, else 0' })
  @IsOptional()
  @IsNumberString()
  minNotional?: string;

  @ApiPropertyOptional({
    enum: TickerStatus,
    description: 'Defaults to PENDING (registered, not yet tradable until the engine is restarted)',
  })
  @IsOptional()
  @IsEnum(TickerStatus)
  status?: TickerStatus;

  @ApiPropertyOptional({
    example: 'Bitcoin Test 1',
    description: 'Display name for a new base asset',
  })
  @IsOptional()
  @IsString()
  baseName?: string;
}
