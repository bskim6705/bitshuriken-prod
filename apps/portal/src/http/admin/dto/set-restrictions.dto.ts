import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** 계정 제한 개별 토글. 보낸 필드만 변경된다. */
export class SetRestrictionsDto {
  @ApiPropertyOptional({ description: 'false = 로그인 차단' })
  @IsOptional()
  @IsBoolean()
  loginEnabled?: boolean;

  @ApiPropertyOptional({ description: 'false = 신규 주문 차단' })
  @IsOptional()
  @IsBoolean()
  tradingEnabled?: boolean;

  @ApiPropertyOptional({ description: 'false = 출금 차단' })
  @IsOptional()
  @IsBoolean()
  withdrawalEnabled?: boolean;

  @ApiPropertyOptional({ example: '123456' })
  @IsOptional()
  @IsString()
  totpCode?: string;
}
