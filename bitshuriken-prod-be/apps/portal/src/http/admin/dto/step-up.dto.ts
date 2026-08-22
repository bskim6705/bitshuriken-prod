import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** 위험 작업 step-up용 공통 바디 — admin 2FA 코드만 받는다. */
export class StepUpDto {
  @ApiPropertyOptional({ example: '123456' })
  @IsOptional()
  @IsString()
  totpCode?: string;
}
