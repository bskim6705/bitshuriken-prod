import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { Response } from 'express';
import { ErrorCode } from '../constants/error-codes';
import { DomainException } from '../exceptions/domain.exception';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException ? exception.message : 'Internal server error';

    // DomainException은 자체 code 사용, 그 외(프레임워크 발생분)는 status 기반 매핑 유지
    const code =
      exception instanceof DomainException ? exception.code : this.mapStatusToErrorCode(status);

    response.status(status).json({ code, message, data: null });
  }

  private mapStatusToErrorCode(status: number): number {
    switch (status) {
      case 400:
        return ErrorCode.VALIDATION_ERROR;
      case 401:
        return ErrorCode.UNAUTHORIZED;
      case 404:
        return ErrorCode.NOT_FOUND;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }
}
