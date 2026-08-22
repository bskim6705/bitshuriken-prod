import { IsEnum, IsInt, IsNumberString, IsOptional, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MarginMode } from '@prisma/client';

// {leverage} XOR {marginDelta} XOR {marginMode} — 동시/공백은 서비스에서 거부
export class UpdatePositionDto {
  @ApiPropertyOptional({ example: 20, description: '1..maxLeverage, qty==0일 때만' })
  @IsOptional()
  @IsInt()
  @Min(1)
  leverage?: number;

  @ApiPropertyOptional({
    example: '-50.00000000',
    description: 'signed USDT (max 8dp). ISOLATED 전용',
  })
  @IsOptional()
  @IsNumberString()
  marginDelta?: string;

  @ApiPropertyOptional({ enum: MarginMode, description: 'ISOLATED|CROSS, qty==0일 때만' })
  @IsOptional()
  @IsEnum(MarginMode)
  marginMode?: MarginMode;
}
