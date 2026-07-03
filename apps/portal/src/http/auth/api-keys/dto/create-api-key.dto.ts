import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CreateApiKeyDto {
  @ApiPropertyOptional({ example: 'trading bot 1' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  label?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  canTrade?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  canRead?: boolean;

  @ApiPropertyOptional({
    example: '123456',
    description: '6-digit TOTP code (required if 2FA enabled)',
  })
  @IsOptional()
  @IsString()
  totpCode?: string;
}
