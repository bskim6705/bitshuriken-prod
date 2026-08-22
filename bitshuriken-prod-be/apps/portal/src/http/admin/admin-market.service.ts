import { Injectable, HttpStatus, Logger } from '@nestjs/common';
import { AssetType, MarketType, TickerStatus } from '@prisma/client';
import { PrismaService } from '@app/infra/prisma/prisma.service';
import { KafkaService } from '@app/infra/messaging/kafka.service';
import { controlTopic, ControlOp, CONTROL_PARTITION } from '@app/infra/messaging/topics';
import { DomainException } from '@app/shared/exceptions/domain.exception';
import { ErrorCode } from '@app/shared/constants/error-codes';
import { matchPartitionCount, partitionForSymbol } from '@app/shared/partition';
import { CreateTickerDto } from './dto/create-ticker.dto';

// 매칭엔진을 가진 마켓만 control 토픽으로 전파 (DEX는 동기 AMM, OPTIONS는 미배포).
const ENGINE_MARKETS = new Set<MarketType>([MarketType.SPOT, MarketType.FUTURES]);

// 신규 futures ticker 기본 정책값 (seed FUTURES_CONFIG_DEFAULTS와 동일). 운영 중 DB에서 조정.
const FUTURES_CONFIG_DEFAULTS = {
  maxLeverage: 50,
  mmr: '0.005',
  liquidationFeeRate: '0.005',
  maxNotional: '1000000',
  fundingCap: '0.003',
  priceBandPct: '0.05',
  marketCostBufferPct: '0.005',
  markClampPct: '0.005',
};

const STABLECOINS = new Set(['USDT', 'USDC']);

/**
 * 상장 라이프사이클 (리스팅/디리스팅/상태). 자금 이동과 분리 — secret/세션 admin 양쪽 허용(2FA 불필요).
 * status 변경은 주문 게이트에 즉시 효력. 신규 ticker 생성은 DB 등록 후 control 토픽으로 전파 —
 * 엔진은 lane을 in-memory 추가, Nest 앱은 meta 캐시를 upsert해 재시작 없이 거래/노출 가능.
 * 파티션은 FNV-1a(symbol)%P 고정 버킷이라 신규 상장에 Kafka 파티션 증설은 불필요.
 */
@Injectable()
export class AdminMarketService {
  private readonly logger = new Logger(AdminMarketService.name);

  constructor(
    private prisma: PrismaService,
    private kafka: KafkaService,
  ) {}

  async listTickers() {
    const tickers = await this.prisma.ticker.findMany({
      orderBy: [{ marketType: 'asc' }, { symbol: 'asc' }],
    });
    return tickers.map((t) => ({
      symbol: t.symbol,
      marketType: t.marketType,
      baseAsset: t.baseAssetSymbol,
      quoteAsset: t.quoteAssetSymbol,
      status: t.status,
      pricePrecision: t.pricePrecision,
      qtyPrecision: t.qtyPrecision,
      minNotional: t.minNotional.toFixed(8),
      partition: t.partition,
    }));
  }

  /** 상장 상태 변경. 주문 게이트(assertTradable, DB 라이브)에 즉시 반영. markets 노출/라벨은 재시작 후. */
  async setTickerStatus(market: MarketType, symbol: string, status: TickerStatus) {
    const ticker = await this.prisma.ticker.findUnique({
      where: { symbol_marketType: { symbol, marketType: market } },
      select: { status: true },
    });
    if (!ticker)
      throw new DomainException(
        ErrorCode.TICKER_NOT_FOUND,
        'Ticker not found',
        HttpStatus.NOT_FOUND,
      );
    const updated = await this.prisma.ticker.update({
      where: { symbol_marketType: { symbol, marketType: market } },
      data: { status },
      select: { symbol: true, marketType: true, status: true },
    });
    return {
      symbol: updated.symbol,
      marketType: updated.marketType,
      status: updated.status,
      previousStatus: ticker.status,
    };
  }

  /**
   * 신규 ticker 등록(DB only). base/quote Asset 없으면 생성, 파티션 미지정 시 FNV-1a(symbol)%P 고정 버킷 자동.
   * 기본 status=PENDING — 엔진이 lane을 갖기 전엔 거래 불가(주문 게이트가 막음).
   */
  async createTicker(dto: CreateTickerDto) {
    const market = dto.market;
    const base = dto.baseAsset.toUpperCase();
    const quote = dto.quoteAsset.toUpperCase();
    const symbol = (dto.symbol ?? `${base}${quote}`).toUpperCase();

    if (dto.pricePrecision + dto.qtyPrecision > 8)
      throw new DomainException(
        ErrorCode.INVALID_PARAMETER,
        'pricePrecision + qtyPrecision must be <= 8 (engine floor / settlement invariant)',
      );

    const existing = await this.prisma.ticker.findUnique({
      where: { symbol_marketType: { symbol, marketType: market } },
      select: { symbol: true },
    });
    if (existing)
      throw new DomainException(
        ErrorCode.TICKER_ALREADY_EXISTS,
        `${symbol} (${market}) already exists`,
        HttpStatus.CONFLICT,
      );

    // 버킷 배정은 symbol-deterministic해야 config/seed/엔진과 일치 (FNV-1a(symbol) % P).
    const partitions = matchPartitionCount(market);
    const partition = partitionForSymbol(symbol, partitions);
    if (dto.partition != null && dto.partition !== partition) {
      throw new DomainException(
        ErrorCode.INVALID_PARAMETER,
        `partition은 FNV-1a(${symbol}) % ${partitions} = ${partition} 이어야 함 (받은 값 ${dto.partition})`,
      );
    }

    const minNotional = dto.minNotional ?? (STABLECOINS.has(quote) ? '5' : '0');
    const status = dto.status ?? TickerStatus.PENDING;

    const ticker = await this.prisma.$transaction(async (tx) => {
      await tx.asset.upsert({
        where: { symbol: base },
        update: {},
        create: { symbol: base, name: dto.baseName ?? base, precision: 8, type: AssetType.CRYPTO },
      });
      await tx.asset.upsert({
        where: { symbol: quote },
        update: {},
        create: {
          symbol: quote,
          name: quote,
          precision: STABLECOINS.has(quote) ? 6 : 8,
          type: STABLECOINS.has(quote) ? AssetType.STABLECOIN : AssetType.CRYPTO,
        },
      });
      const created = await tx.ticker.create({
        data: {
          symbol,
          marketType: market,
          baseAssetSymbol: base,
          quoteAssetSymbol: quote,
          pricePrecision: dto.pricePrecision,
          qtyPrecision: dto.qtyPrecision,
          minNotional,
          partition,
          status,
        },
      });
      if (market === MarketType.FUTURES) {
        await tx.futuresConfig.upsert({
          where: { tickerSymbol: symbol },
          update: {},
          create: { tickerSymbol: symbol, ...FUTURES_CONFIG_DEFAULTS },
        });
      }
      return created;
    });

    // control 토픽으로 전파 — 엔진 lane 추가 + Nest meta upsert(재시작 불필요). compaction이라
    // 재시작 후에도 보존. produce 실패 시에도 DB가 권위 소스 → 경고만, 재시작이 fallback.
    const propagated = await this.publishTickerAdd({
      market,
      symbol,
      baseAsset: base,
      quoteAsset: quote,
      partition: ticker.partition,
      pricePrecision: ticker.pricePrecision,
      qtyPrecision: ticker.qtyPrecision,
      minNotional,
    });

    return {
      symbol: ticker.symbol,
      marketType: ticker.marketType,
      baseAsset: base,
      quoteAsset: quote,
      partition: ticker.partition,
      pricePrecision: ticker.pricePrecision,
      qtyPrecision: ticker.qtyPrecision,
      minNotional: ticker.minNotional.toFixed(8),
      status: ticker.status,
      propagated,
      // PENDING으로 생성 시, 거래는 status를 TRADING으로 열어야 시작.
      nextSteps: propagated
        ? [`Set status to TRADING (PATCH /admin/tickers/${market}/${symbol}/status)`]
        : [
            'Control propagation failed — restart the match engine and the Nest apps (boot-load fallback)',
            `Then set status to TRADING (PATCH /admin/tickers/${market}/${symbol}/status)`,
          ],
    };
  }

  /** control 토픽에 add 발행. 엔진(lane)·Nest(meta)가 같은 메시지를 소비. 성공 여부 반환. */
  private async publishTickerAdd(t: {
    market: MarketType;
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    partition: number;
    pricePrecision: number;
    qtyPrecision: number;
    minNotional: string;
  }): Promise<boolean> {
    if (!ENGINE_MARKETS.has(t.market)) return false;
    try {
      await this.kafka.emit(
        controlTopic(t.market),
        CONTROL_PARTITION,
        {
          op: ControlOp.ADD_TICKER,
          market: t.market.toLowerCase(),
          symbol: t.symbol,
          baseAsset: t.baseAsset,
          quoteAsset: t.quoteAsset,
          partition: t.partition,
          pricePrecision: t.pricePrecision,
          qtyPrecision: t.qtyPrecision,
          minNotional: t.minNotional,
        },
        t.symbol, // key=symbol (compaction)
      );
      return true;
    } catch (e) {
      this.logger.error(`control publish failed for ${t.market}:${t.symbol}: ${String(e)}`);
      return false;
    }
  }
}
