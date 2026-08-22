import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class VerifyEmailDto {
  @ApiProperty({ description: 'Email verification token from the link' })
  @IsString()
  @IsNotEmpty()
  token: string;
}
