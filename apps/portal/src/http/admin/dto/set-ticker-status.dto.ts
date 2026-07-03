import { IsEnum, IsOptional, IsString } from 'class-validator';
import { TickerStatus } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SetTickerStatusDto {
  @ApiProperty({
    enum: TickerStatus,
    description: 'PENDING=준비중, TRADING=거래, HALTED=거래중단, DELISTED=상장폐지',
  })
  @IsEnum(TickerStatus)
  status: TickerStatus;

  @ApiPropertyOptional({ example: '123456' })
  @IsOptional()
  @IsString()
  totpCode?: string;
}
