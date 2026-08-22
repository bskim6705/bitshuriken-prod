import { IsEnum, IsOptional, IsString } from 'class-validator';
import { UserRole } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SetRoleDto {
  @ApiProperty({ enum: UserRole })
  @IsEnum(UserRole)
  role: UserRole;

  @ApiPropertyOptional({ example: '123456' })
  @IsOptional()
  @IsString()
  totpCode?: string;
}
