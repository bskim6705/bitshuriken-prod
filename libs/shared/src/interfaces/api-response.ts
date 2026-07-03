import { ApiProperty } from '@nestjs/swagger';

export class ApiResponse<T = unknown> {
  @ApiProperty({ description: '0이면 성공, 그 외는 에러 코드' })
  code: number;

  @ApiProperty({ description: '응답 메시지' })
  message: string;

  @ApiProperty({ description: '응답 데이터', nullable: true })
  data: T | null;
}
