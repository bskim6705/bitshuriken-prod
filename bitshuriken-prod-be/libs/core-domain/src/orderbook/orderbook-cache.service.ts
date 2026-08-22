import { Injectable, Logger } from '@nestjs/common';
import { MarketType } from '@prisma/client';
import { DepthDiffData } from '@app/infra/messaging/match-message.parser';

type Side = 'bid' | 'ask';

interface OrderBookState {
  bids: Map<string, string>; // raw int*10^8 priceStr → qtyStr
  asks: Map<string, string>;
  lastUpdateId: number;
  bestBid: bigint | null; // 증분 추적되는 최우선 호가 (raw 스케일)
  bestAsk: bigint | null;
}

/** raw int*10^8 string — decimal 포맷은 호출자(REST/WS) 책임. */
export interface DepthSnapshot {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
}

/** price/qty는 raw int*10^8 string. */
export interface BookTicker {
  symbol: string;
  bidPrice: string;
  bidQty: string;
  askPrice: string;
  askQty: string;
  lastUpdateId: number;
}

const EMPTY_DEPTH: DepthSnapshot = { lastUpdateId: 0, bids: [], asks: [] };

/**
 * 매칭엔진의 depth diff stream을 적용해서 BE 측 OB를 reconstruction.
 * depth, bookTicker 모두 여기서 파생.
 *
 * Phase 1: gap 감지 / snapshot recovery 없음. BE 부팅 순서를 운영 책임으로 가정.
 */
@Injectable()
export class OrderBookCacheService {
  private readonly logger = new Logger(OrderBookCacheService.name);
  private books = new Map<string, OrderBookState>();
  // bookTickerIfChanged가 마지막으로 반환한 (bidP|bidQ|askP|askQ) — lastUpdateId 제외
  private lastReturnedBest = new Map<string, string>();
  // u 역행 error 로그 1회 가드 (book별) — 전진 적용 시 리셋
  private regressionWarned = new Set<string>();

  applyDiff(market: MarketType, diff: DepthDiffData): void {
    const key = this.key(market, diff.symbol);
    let book = this.books.get(key);
    if (!book) {
      book = { bids: new Map(), asks: new Map(), lastUpdateId: 0, bestBid: null, bestAsk: null };
      this.books.set(key, book);
    }
    // 시퀀스 가드: 이미 적용한 u 이하는 drop (엔진 replay 재방출은 정상)
    if (book.lastUpdateId > 0 && diff.lastUpdateId <= book.lastUpdateId) {
      if (diff.lastUpdateId < book.lastUpdateId && !this.regressionWarned.has(key)) {
        this.regressionWarned.add(key);
        this.logger.error(
          `${key} lastUpdateId 역행: 수신 ${diff.lastUpdateId} < 보유 ${book.lastUpdateId}. ` +
            `정상 replay면 곧 따라잡힘. 엔진이 빈 책으로 재시작된 경우 BE도 재시작 필요`,
        );
      } else {
        this.logger.debug(`${key} stale DPD drop (u=${diff.lastUpdateId})`);
      }
      return;
    }
    this.regressionWarned.delete(key);
    book.bestBid = this.applySide(book.bids, diff.bids, book.bestBid, 'bid');
    book.bestAsk = this.applySide(book.asks, diff.asks, book.bestAsk, 'ask');
    book.lastUpdateId = diff.lastUpdateId;
  }

  getDepth(market: MarketType, symbol: string, limit: number): DepthSnapshot {
    const book = this.books.get(this.key(market, symbol));
    if (!book) return EMPTY_DEPTH;
    return {
      lastUpdateId: book.lastUpdateId,
      bids: this.topLevels(book.bids, 'desc', limit),
      asks: this.topLevels(book.asks, 'asc', limit),
    };
  }

  getBookTicker(market: MarketType, symbol: string): BookTicker | null {
    const book = this.books.get(this.key(market, symbol));
    if (!book || book.bestBid === null || book.bestAsk === null) return null;
    const bidPrice = book.bestBid.toString();
    const askPrice = book.bestAsk.toString();
    return {
      symbol,
      bidPrice,
      bidQty: book.bids.get(bidPrice) ?? '0',
      askPrice,
      askQty: book.asks.get(askPrice) ?? '0',
      lastUpdateId: book.lastUpdateId,
    };
  }

  /**
   * 직전 반환값과 best (price,qty) 양측이 동일하면 null — lastUpdateId는 비교에서 제외.
   * gateway가 DPD 후 실제 변경 시에만 push하는 용도.
   */
  bookTickerIfChanged(market: MarketType, symbol: string): BookTicker | null {
    const t = this.getBookTicker(market, symbol);
    if (!t) return null;
    const key = this.key(market, symbol);
    const sig = `${t.bidPrice}|${t.bidQty}|${t.askPrice}|${t.askQty}`;
    if (this.lastReturnedBest.get(key) === sig) return null;
    this.lastReturnedBest.set(key, sig);
    return t;
  }

  /**
   * 증분 best 추적: 개선 가격 삽입은 O(1), best 레벨이 삭제된 경우에만 선형 재스캔.
   * 전체 sort 없음.
   */
  private applySide(
    levels: Map<string, string>,
    changes: [string, string][],
    best: bigint | null,
    side: Side,
  ): bigint | null {
    let bestDeleted = false;
    for (const [price, qty] of changes) {
      if (qty === '0') {
        levels.delete(price);
        if (best !== null && BigInt(price) === best) bestDeleted = true;
      } else {
        levels.set(price, qty);
        const p = BigInt(price);
        if (best === null || (side === 'bid' ? p > best : p < best)) best = p;
      }
    }
    // 삭제된 best가 이후 set으로 대체/재삽입되지 않았을 때만 재스캔
    if (bestDeleted && (best === null || !levels.has(best.toString()))) {
      best = this.scanBest(levels, side);
    }
    return best;
  }

  private scanBest(levels: Map<string, string>, side: Side): bigint | null {
    let best: bigint | null = null;
    for (const price of levels.keys()) {
      const p = BigInt(price);
      if (best === null || (side === 'bid' ? p > best : p < best)) best = p;
    }
    return best;
  }

  private key(market: MarketType, symbol: string): string {
    return `${market}/${symbol}`;
  }

  /** 가격 정렬 후 상위 N. raw int string은 자릿수가 다를 수 있어 BigInt로 비교. */
  private topLevels(
    levels: Map<string, string>,
    dir: 'asc' | 'desc',
    limit: number,
  ): [string, string][] {
    const arr = [...levels.entries()];
    arr.sort(([a], [b]) => {
      const ba = BigInt(a);
      const bb = BigInt(b);
      if (ba === bb) return 0;
      const cmp = ba < bb ? -1 : 1;
      return dir === 'asc' ? cmp : -cmp;
    });
    return arr.slice(0, limit);
  }
}
