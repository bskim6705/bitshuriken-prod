import { IsEmail, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'alice@test.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  password: string;

  @ApiPropertyOptional({
    example: '123456',
    description: '6-digit TOTP code (required if 2FA enabled)',
  })
  @IsOptional()
  @IsString()
  totpCode?: string;
}
