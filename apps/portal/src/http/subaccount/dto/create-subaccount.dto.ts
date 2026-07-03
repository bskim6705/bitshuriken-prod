import { IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class CreateSubaccountDto {
  @ApiPropertyOptional({ example: 'arb-bot-1', description: 'Human label for the subaccount' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  label?: string;
}
