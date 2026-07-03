import { IsNotEmpty, IsNumberString, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FundingDto {
  @ApiProperty({ example: 'USDT' })
  @IsString()
  @IsNotEmpty()
  assetSymbol: string;

  @ApiProperty({ example: '1000.00000000' })
  @IsNumberString()
  qty: string;

  @ApiPropertyOptional({
    example: '123456',
    description: '6-digit TOTP code (required for withdrawals if 2FA enabled)',
  })
  @IsOptional()
  @IsString()
  totpCode?: string;
}
