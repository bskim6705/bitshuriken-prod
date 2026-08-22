import { IsString, IsNotEmpty, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ResetPasswordDto {
  @ApiProperty({ description: 'Password reset token from the link' })
  @IsString()
  @IsNotEmpty()
  token: string;

  @ApiProperty({ example: 'newPassword123', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;
}
