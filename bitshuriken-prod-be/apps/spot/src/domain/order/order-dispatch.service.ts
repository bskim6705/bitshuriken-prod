import { Injectable, HttpStatus } from '@nestjs/common';
import { MarketType, Order } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { KafkaService } from '@app/infra/messaging/kafka.service';
import { inboundTopic } from '@app/infra/messaging/topics';
import {
  serializeCancelOrder,
  serializeNewOrder,
} from '@app/infra/messaging/match-message.serializer';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';

/**
 * 엔진 NO/CO 전송 단일 지점 (직렬화 + ticker partition 조회 캐시).
 * Order/Trigger/OrderList 서비스가 공유 — 서비스 간 순환 의존 방지용 standalone.
 */
@Injectable()
export class OrderDispatchService {
  private readonly partitions = new Map<string, number>();

  constructor(
    private prisma: PrismaService,
    private kafka: KafkaService,
  ) {}

  async dispatchNewOrder(order: Order): Promise<void> {
    const partition = await this.partitionOf(order.tickerMarket, order.tickerSymbol);
    await this.kafka.emit(inboundTopic(order.tickerMarket), partition, serializeNewOrder(order), order.tickerSymbol);
  }

  async dispatchCancelOrder(order: Order): Promise<void> {
    const partition = await this.partitionOf(order.tickerMarket, order.tickerSymbol);
    await this.kafka.emit(inboundTopic(order.tickerMarket), partition, serializeCancelOrder(order), order.tickerSymbol);
  }

  private async partitionOf(market: MarketType, symbol: string): Promise<number> {
    const key = `${market}:${symbol}`;
    const cached = this.partitions.get(key);
    if (cached !== undefined) return cached;

    const ticker = await this.prisma.ticker.findUnique({
      where: { symbol_marketType: { symbol, marketType: market } },
      select: { partition: true },
    });
    if (!ticker)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        `Ticker ${market}/${symbol} not found`,
        HttpStatus.NOT_FOUND,
      );

    this.partitions.set(key, ticker.partition);
    return ticker.partition;
  }
}
