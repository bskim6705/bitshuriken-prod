import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsIP,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
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
    example: ['203.0.113.7'],
    description: 'Allowed source IPs (empty = unrestricted). Each must be a valid IPv4/IPv6.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsIP(undefined, { each: true })
  ipWhitelist?: string[];

  @ApiPropertyOptional({
    example: 90,
    description: 'Days until the key expires (omit for no expiry). 1–365.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  expiresInDays?: number;

  @ApiPropertyOptional({
    example: '123456',
    description: '6-digit TOTP code (required if 2FA enabled)',
  })
  @IsOptional()
  @IsString()
  totpCode?: string;
}
