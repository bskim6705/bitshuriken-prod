import { IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TwoFactorCodeDto {
  @ApiProperty({ example: '123456', description: '6-digit TOTP code from your authenticator app' })
  @IsString()
  @Length(6, 6)
  code: string;
}
