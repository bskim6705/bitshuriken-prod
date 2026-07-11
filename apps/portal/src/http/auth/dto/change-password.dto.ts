import { IsString, IsNotEmpty, IsOptional, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChangePasswordDto {
  @ApiProperty({ example: 'currentPassword123' })
  @IsString()
  @IsNotEmpty()
  oldPassword: string;

  @ApiProperty({ example: 'newPassword123', minLength: 8 })
  @IsString()
  @MinLength(8)
  newPassword: string;

  @ApiPropertyOptional({
    example: '123456',
    description: '6-digit TOTP code (required if 2FA enabled)',
  })
  @IsOptional()
  @IsString()
  totpCode?: string;
}
