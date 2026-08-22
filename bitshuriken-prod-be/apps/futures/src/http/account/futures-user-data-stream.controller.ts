import { Controller, Delete, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@app/shared/decorators/current-user.decorator';
import type { CurrentUserPayload } from '@app/shared/decorators/current-user.decorator';
import { PrivateGuard } from '@app/core-domain/auth/guards/private.guard';
import { FuturesListenKeyService } from '../../user-events/futures-listen-key.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

/**
 * Futures listenKey 발급/연장/폐기 (spot user-data-stream 복제). 스트림 본체는 /ws/fuser 게이트웨이.
 */
@ApiTags('futures/user-data-stream')
@ApiSecurity('cookieAuth')
@ApiSecurity('apiKey')
@UseGuards(PrivateGuard)
@Controller('futures/account/user-data-stream')
export class FuturesUserDataStreamController {
  constructor(private readonly listenKeys: FuturesListenKeyService) {}

  @Post()
  @ApiOperation({ summary: 'Create a listenKey for the /ws/fuser user data stream' })
  @ApiResponse({
    status: 201,
    description: 'New listenKey to subscribe to the futures user data stream.',
    example: { code: 0, message: 'ok', data: { listenKey: 'fk_3a9c1e7b2d' } },
  })
  create(@CurrentUser() user: CurrentUserPayload) {
    return { listenKey: this.listenKeys.create(user.userId) };
  }

  @Put()
  @ApiOperation({ summary: 'Keepalive (extend TTL of) an existing listenKey' })
  @ApiQuery({
    name: 'listenKey',
    type: String,
    required: true,
    description: 'The listenKey to extend',
  })
  @ApiResponse({
    status: 200,
    description: 'listenKey TTL extended.',
    example: { code: 0, message: 'ok', data: {} },
  })
  keepalive(@Query('listenKey') listenKey?: string) {
    if (!listenKey) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'listenKey is required');
    this.listenKeys.keepalive(listenKey);
    return {};
  }

  @Delete()
  @ApiOperation({ summary: 'Revoke (close) a listenKey' })
  @ApiQuery({
    name: 'listenKey',
    type: String,
    required: true,
    description: 'The listenKey to revoke',
  })
  @ApiResponse({
    status: 200,
    description: 'listenKey revoked.',
    example: { code: 0, message: 'ok', data: {} },
  })
  revoke(@Query('listenKey') listenKey?: string) {
    if (!listenKey) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'listenKey is required');
    this.listenKeys.revoke(listenKey);
    return {};
  }
}
