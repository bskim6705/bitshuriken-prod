/**
 * 매칭 파티션 버킷 배정. 심볼-결정적이라 match config / seed / BE-produce가 약속 없이 일치.
 * P를 바꾸면 config 재생성 + 재시드 + 토픽 재생성이 필요 (docs/adr 참조).
 */

export const DEFAULT_MATCH_PARTITIONS = 6;

/** FNV-1a (32-bit) over UTF-8 bytes. match config 생성기와 동일해야 함 — 변경 금지. */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  const bytes = Buffer.from(input, 'utf8');
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0; // (hash * prime) mod 2^32
  }
  return hash >>> 0;
}

/** 심볼이 들어갈 파티션 버킷: FNV-1a(symbol) % P. */
export function partitionForSymbol(symbol: string, partitions: number): number {
  return fnv1a32(symbol) % partitions;
}

/** 마켓별 버킷 수(P). infra의 MATCH_*_PARTITIONS와 반드시 동일해야 함. */
export function matchPartitionCount(market: string, env: NodeJS.ProcessEnv = process.env): number {
  const key =
    market.toUpperCase() === 'FUTURES' ? 'MATCH_FUTURES_PARTITIONS' : 'MATCH_SPOT_PARTITIONS';
  const raw = env[key];
  if (raw == null || raw === '') return DEFAULT_MATCH_PARTITIONS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${key} must be a positive integer (got "${raw}")`);
  }
  return n;
}
