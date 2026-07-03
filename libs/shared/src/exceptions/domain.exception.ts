import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCodeType } from '../constants/error-codes';

/** 도메인 에러. code는 응답 envelope의 code, status는 HTTP status로 나간다. */
export class DomainException extends HttpException {
  constructor(
    readonly code: ErrorCodeType,
    message: string,
    status: number = HttpStatus.BAD_REQUEST,
  ) {
    super(message, status);
  }
}
