import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiExcludeController,
  ApiOperation,
  ApiResponse,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '@app/shared/decorators/current-user.decorator';
import type { CurrentUserPayload } from '@app/shared/decorators/current-user.decorator';
import { PrivateGuard } from '@app/core-domain/auth/guards/private.guard';
import { RequireApiScope, ApiScope } from '@app/shared/decorators/api-scope.decorator';
import { FundingService } from './funding.service';
import { FundingDto } from './dto/funding.dto';
import { SecurityNotifyService } from '../../notify/security-notify.service';

// Excluded from the API reference: dev-only simulated funding (no on-chain flow).
@ApiExcludeController()
@ApiTags('account/funding')
@ApiBearerAuth()
@ApiCookieAuth('cookieAuth')
@ApiSecurity('apiKey')
@UseGuards(PrivateGuard)
@RequireApiScope(ApiScope.TRADE)
@Controller('account')
export class FundingController {
  constructor(
    private readonly fundingService: FundingService,
    private readonly notify: SecurityNotifyService,
  ) {}

  @Post('deposits')
  @ApiOperation({ summary: 'Deposit into spot wallet (dev: instant credit, no chain)' })
  @ApiResponse({
    status: 201,
    description: 'Deposit credited to the spot wallet.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        depositId: 'd1e2f3a4-b5c6-4d7e-8f90-1a2b3c4d5e6f',
        assetSymbol: 'USDT',
        qty: '1000.00000000',
        marketType: 'SPOT',
      },
    },
  })
  deposit(@CurrentUser() user: CurrentUserPayload, @Body() dto: FundingDto) {
    return this.fundingService.deposit(user.userId, dto);
  }

  @Post('withdrawals')
  @ApiOperation({ summary: 'Withdraw from spot wallet (dev: instant debit, no chain)' })
  @ApiResponse({
    status: 201,
    description: 'Withdrawal debited from the spot wallet.',
    example: {
      code: 0,
      message: 'ok',
      data: {
        withdrawalId: 'w1e2f3a4-b5c6-4d7e-8f90-1a2b3c4d5e6f',
        assetSymbol: 'USDT',
        qty: '250.00000000',
        marketType: 'SPOT',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Insufficient balance.',
    example: { code: 2001, message: 'Insufficient balance', data: null },
  })
  async withdraw(@CurrentUser() user: CurrentUserPayload, @Body() dto: FundingDto) {
    const result = await this.fundingService.withdraw(user.userId, dto);
    this.notify.withdrawalConfirmation(user.email, result.assetSymbol, result.qty);
    return result;
  }
}
