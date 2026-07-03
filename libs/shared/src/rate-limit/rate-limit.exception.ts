import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../exceptions/domain.exception';
import { ErrorCode } from '../constants/error-codes';

/** REQUEST_WEIGHT / RAW_REQUESTS 한도 초과 → 429. */
export class RateLimitException extends DomainException {
  constructor(message = 'Rate limit exceeded') {
    super(ErrorCode.RATE_LIMITED, message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/** ORDERS 한도 초과 → 429 (Binance -1015 대응). */
export class TooManyOrdersException extends DomainException {
  constructor(message = 'Too many new orders') {
    super(ErrorCode.TOO_MANY_NEW_ORDERS, message, HttpStatus.TOO_MANY_REQUESTS);
  }
}
