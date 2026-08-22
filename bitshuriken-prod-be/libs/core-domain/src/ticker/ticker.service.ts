import { Injectable } from '@nestjs/common';
import { MarketType } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';

@Injectable()
export class TickerService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.ticker.findMany({
      orderBy: [{ marketType: 'asc' }, { symbol: 'asc' }],
    });
  }

  findByMarket(market: MarketType) {
    return this.prisma.ticker.findMany({
      where: { marketType: market },
      orderBy: { symbol: 'asc' },
    });
  }
}
