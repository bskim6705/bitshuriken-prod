import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AntiPhishingDto {
  @ApiProperty({
    example: 'blue-otter-42',
    description: 'Code shown atop every email. Empty string clears it. Max 32 chars.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  code?: string | null;

  @ApiPropertyOptional({
    example: '123456',
    description: '6-digit TOTP code (required if 2FA enabled)',
  })
  @IsOptional()
  @IsString()
  totpCode?: string;
}
