import { Controller, Delete, Post, Put, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '@app/shared/decorators/current-user.decorator';
import type { CurrentUserPayload } from '@app/shared/decorators/current-user.decorator';
import { PrivateGuard } from '@app/core-domain/auth/guards/private.guard';
import { ListenKeyService } from '../../../../domain/user-stream/listen-key.service';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

/**
 * User data stream listenKey 발급/연장/폐기. 스트림 본체는 /ws/user 게이트웨이.
 */
@ApiTags('spot/user-data-stream')
@ApiBearerAuth()
@ApiSecurity('cookieAuth')
@ApiSecurity('apiKey')
@UseGuards(PrivateGuard)
@Controller('spot/user-data-stream')
export class UserDataStreamController {
  constructor(private readonly listenKeys: ListenKeyService) {}

  @Post()
  @ApiOperation({ summary: 'Create a listenKey for the /ws/user stream (60-min expiry)' })
  @ApiResponse({
    status: 201,
    description: 'New listenKey to open the user data WebSocket stream',
    example: { code: 0, message: 'ok', data: { listenKey: 'pqia91ma19a5s61cv6...' } },
  })
  create(@CurrentUser() user: CurrentUserPayload) {
    return { listenKey: this.listenKeys.create(user.userId) };
  }

  @Put()
  @ApiOperation({ summary: 'Keepalive a listenKey (extend expiry by 60 min)' })
  @ApiQuery({ name: 'listenKey', type: String, required: true, description: 'listenKey to renew' })
  keepalive(@Query('listenKey') listenKey?: string) {
    if (!listenKey) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'listenKey is required');
    this.listenKeys.keepalive(listenKey);
    return {};
  }

  @Delete()
  @ApiOperation({ summary: 'Revoke a listenKey (closes the stream)' })
  @ApiQuery({ name: 'listenKey', type: String, required: true, description: 'listenKey to revoke' })
  revoke(@Query('listenKey') listenKey?: string) {
    if (!listenKey) throw new DomainException(ErrorCode.PARAM_REQUIRED, 'listenKey is required');
    this.listenKeys.revoke(listenKey);
    return {};
  }
}
