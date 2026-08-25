import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MAX_FEE_TIER } from '@app/shared/constants/fee-tiers';

export class UpdateFeeTierDto {
  @ApiProperty({ example: 0, description: `Fee tier, [0, ${MAX_FEE_TIER}] — 요율은 코드 테이블(fee-tiers.ts)` })
  @IsInt()
  @Min(0)
  @Max(MAX_FEE_TIER)
  feeTier: number;

  @ApiPropertyOptional({ example: '123456' })
  @IsOptional()
  @IsString()
  totpCode?: string;
}
