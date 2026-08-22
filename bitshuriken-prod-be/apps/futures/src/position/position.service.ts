import { Injectable } from '@nestjs/common';
import { PrismaService } from '@app/infra/prisma/prisma.service';

@Injectable()
export class PositionService {
  constructor(private prisma: PrismaService) {}

  findByUserAndSymbol(userId: string, tickerSymbol: string) {
    return this.prisma.position.findUnique({
      where: { userId_tickerSymbol: { userId, tickerSymbol } },
    });
  }
}
