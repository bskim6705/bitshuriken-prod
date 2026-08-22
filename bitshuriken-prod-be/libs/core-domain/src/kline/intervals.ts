/** Kline 인터벌 단일 소스. exchange-info와 kline 계산이 공유한다. */
export const KLINE_INTERVALS = [
  '1s',
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
  '1M',
] as const;

export type KlineInterval = (typeof KLINE_INTERVALS)[number];

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** 고정폭 인터벌의 ms. 1M은 달력(월) 기준이라 제외 — bucket 헬퍼가 특별 처리. */
export const INTERVAL_MS: Record<Exclude<KlineInterval, '1M'>, number> = {
  '1s': SECOND_MS,
  '1m': MINUTE_MS,
  '3m': 3 * MINUTE_MS,
  '5m': 5 * MINUTE_MS,
  '15m': 15 * MINUTE_MS,
  '30m': 30 * MINUTE_MS,
  '1h': HOUR_MS,
  '2h': 2 * HOUR_MS,
  '4h': 4 * HOUR_MS,
  '6h': 6 * HOUR_MS,
  '8h': 8 * HOUR_MS,
  '12h': 12 * HOUR_MS,
  '1d': DAY_MS,
  '3d': 3 * DAY_MS,
  '1w': 7 * DAY_MS,
};

/** epoch(1970-01-01, 목요일) → 월요일 정렬 오프셋 = 4일. */
export const WEEK_OFFSET_MS = 345_600_000;

export function isKlineInterval(value: string): value is KlineInterval {
  return (KLINE_INTERVALS as readonly string[]).includes(value);
}

/** ts(epoch ms)가 속한 버킷의 openTime. 1w는 월요일 정렬, 1M은 UTC 월초. */
export function bucketStartMs(interval: KlineInterval, ts: number): number {
  if (interval === '1M') {
    const d = new Date(ts);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
  const w = INTERVAL_MS[interval];
  const off = interval === '1w' ? WEEK_OFFSET_MS : 0;
  return Math.floor((ts - off) / w) * w + off;
}

/** 버킷 openTime → 다음 버킷 openTime. */
export function nextBucketStartMs(interval: KlineInterval, bucketStart: number): number {
  if (interval === '1M') {
    const d = new Date(bucketStart);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  return bucketStart + INTERVAL_MS[interval];
}

/** 윈도 시작 = endTime - limit*w. 1M은 월 단위 산술(월초로 내림). */
export function windowStartMs(interval: KlineInterval, endTime: number, limit: number): number {
  if (interval === '1M') {
    const d = new Date(endTime);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - limit, 1);
  }
  return endTime - limit * INTERVAL_MS[interval];
}
