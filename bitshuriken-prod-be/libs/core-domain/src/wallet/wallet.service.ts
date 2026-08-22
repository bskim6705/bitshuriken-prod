import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/infra/prisma/prisma.service';

@Injectable()
export class WalletService {
  constructor(private prisma: PrismaService) {}

  findByUser(userId: string) {
    return this.prisma.wallet.findMany({
      where: { userId },
      orderBy: [{ marketType: 'asc' }, { assetSymbol: 'asc' }],
    });
  }
}
