import { Injectable, HttpStatus } from '@nestjs/common';
import { MarketType, Order } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { KafkaService } from '@app/infra/messaging/kafka.service';
import { inboundTopic } from '@app/infra/messaging/topics';
import { serializeNewOrder } from '@app/infra/messaging/match-message.serializer';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

const MARKET = MarketType.FUTURES;

/** 트리거 발화 시 엔진 NO 전송 단일 지점 (직렬화 + partition 조회 캐시). */
@Injectable()
export class FuturesOrderDispatchService {
  private readonly partitions = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private kafka: KafkaService,
  ) {}

  async dispatchNewOrder(order: Order): Promise<void> {
    const partition = await this.partitionOf(order.tickerSymbol);
    await this.kafka.emit(inboundTopic(MARKET), partition, serializeNewOrder(order), order.tickerSymbol);
  }

  private async partitionOf(symbol: string): Promise<number> {
    const cached = this.partitions.get(symbol);
    if (cached !== undefined) return cached;

    const ticker = await this.prisma.ticker.findUnique({
      where: { symbol_marketType: { symbol, marketType: MARKET } },
      select: { partition: true },
    });
    if (!ticker)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        `Ticker ${symbol} not found`,
        HttpStatus.NOT_FOUND,
      );

    this.partitions.set(symbol, ticker.partition);
    return ticker.partition;
  }
}
