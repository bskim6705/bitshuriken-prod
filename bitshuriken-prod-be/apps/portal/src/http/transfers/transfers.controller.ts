import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '@app/shared/decorators/current-user.decorator';
import type { CurrentUserPayload } from '@app/shared/decorators/current-user.decorator';
import { PrivateGuard } from '@app/core-domain/auth/guards/private.guard';
import { RequireApiScope, ApiScope } from '@app/shared/decorators/api-scope.decorator';
import { TransfersService } from './transfers.service';
import { CreateTransferDto } from './dto/create-transfer.dto';

@ApiTags('account/transfers')
@ApiBearerAuth()
@ApiCookieAuth('cookieAuth')
@ApiSecurity('apiKey')
@UseGuards(PrivateGuard)
@RequireApiScope(ApiScope.TRADE)
@Controller('account')
export class TransfersController {
  constructor(private readonly transfersService: TransfersService) {}

  @Post('transfers')
  @ApiOperation({ summary: 'Transfer balance between spot and futures wallets' })
  @ApiResponse({
    status: 201,
    description: 'Transfer completed atomically between wallets.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        transferId: 't1e2f3a4-b5c6-4d7e-8f90-1a2b3c4d5e6f',
        fromMarket: 'SPOT',
        toMarket: 'FUTURES',
        assetSymbol: 'USDT',
        qty: '1000.00000000',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Insufficient balance, same source/destination, or pending futures settlement.',
    example: { code: 2001, message: 'Insufficient balance', data: null },
  })
  transfer(@CurrentUser() user: CurrentUserPayload, @Body() dto: CreateTransferDto) {
    return this.transfersService.transfer(user.userId, dto);
  }
}
