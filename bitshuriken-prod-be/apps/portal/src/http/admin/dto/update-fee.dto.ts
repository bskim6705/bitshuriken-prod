import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateFeeDto {
  @ApiProperty({ example: 10, description: 'Maker fee in basis points, [0, 10000)' })
  @IsInt()
  @Min(0)
  @Max(9999)
  feeMakerBps: number;

  @ApiProperty({ example: 10, description: 'Taker fee in basis points, [0, 10000)' })
  @IsInt()
  @Min(0)
  @Max(9999)
  feeTakerBps: number;

  @ApiPropertyOptional({ example: '123456' })
  @IsOptional()
  @IsString()
  totpCode?: string;
}
