import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';
import type { Logger } from '../core/logger';
import { Connectome, NT_CODES, type ConnectomeMeta, type PopRange } from './connectome';
import { POPULATIONS, classify, popIndex, type Population } from './populations';

/** FlyWire Codex 공개 버킷 (로그인 불필요, CC BY 4.0). */
export const FLYWIRE_BUCKET = 'https://storage.googleapis.com/flywire-data/codex/data/fafb/783';
export const RAW_FILES = ['neurons.csv.gz', 'classification.csv.gz', 'connections.csv.gz'] as const;

export async function ensureRaw(dir: string, log: Logger): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const f of RAW_FILES) {
    const p = join(dir, f);
    if (existsSync(p)) continue;
    log.info(`downloading ${f} from FlyWire …`);
    const res = await fetch(`${FLYWIRE_BUCKET}/${f}`);
    if (!res.ok || !res.body) throw new Error(`download ${f}: HTTP ${res.status}`);
    const tmp = `${p}.part`;
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(tmp));
    renameSync(tmp, p);
  }
}

async function* gzLines(path: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  let first = true;
  for await (const line of rl) {
    if (first) {
      first = false; // header
      continue;
    }
    if (line) yield line;
  }
}

export interface BuildOptions {
  region: 'central' | 'full';
  rawDir: string;
  outPath: string;
  log: Logger;
}

/**
 * CSV 3종 → post-major CSR 바이너리. (pre,post) 쌍은 neuropil을 합산하고 시냅스 수에 전달물질 부호
 * (Shiu: GABA·GLUT −)를 곱한다. 합이 0인 쌍은 버린다. central은 VISUAL 집단(시엽·광수용체)을 제외 —
 * 뉴런 1/3·시냅스 40%만 남아 매 bar 시뮬레이션이 4배 빠르다.
 */
export async function buildConnectome(o: BuildOptions): Promise<Connectome> {
  const t0 = Date.now();
  await ensureRaw(o.rawDir, o.log);

  // 1. canonical neuron order + neurotransmitter
  const canon = new Map<string, number>();
  const rootIds: bigint[] = [];
  const nt0: number[] = [];
  for await (const line of gzLines(join(o.rawDir, 'neurons.csv.gz'))) {
    const c = line.split(',');
    canon.set(c[0]!, rootIds.length);
    rootIds.push(BigInt(c[0]!));
    nt0.push(Math.max(0, NT_CODES.indexOf(c[2] as (typeof NT_CODES)[number])));
  }
  const N0 = rootIds.length;

  // 2. populations
  const pop0 = new Uint8Array(N0).fill(popIndex('CENTRAL_OTHER'));
  for await (const line of gzLines(join(o.rawDir, 'classification.csv.gz'))) {
    const c = line.split(',');
    const i = canon.get(c[0]!);
    if (i === undefined) continue;
    pop0[i] = popIndex(classify({ flow: c[1] ?? '', super_class: c[2] ?? '', class: c[3] ?? '', sub_class: c[4] ?? '' }));
  }

  // 3. region filter + reorder so populations are contiguous
  const visual = popIndex('VISUAL');
  const order: number[] = [];
  for (let i = 0; i < N0; i++) if (o.region === 'full' || pop0[i] !== visual) order.push(i);
  order.sort((a, b) => pop0[a]! - pop0[b]! || a - b);
  const N = order.length;
  const newIdx = new Int32Array(N0).fill(-1);
  order.forEach((old, i) => (newIdx[old] = i));
  const populations: PopRange[] = [];
  for (let p = 0, i = 0; p < POPULATIONS.length; p++) {
    const start = i;
    while (i < N && pop0[order[i]!] === p) i++;
    populations.push({ name: POPULATIONS[p] as Population, start, end: i });
  }
  o.log.info(`neurons: ${N0} total → ${N} kept (${o.region}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 4. connections → typed arrays (row = post)
  let cap = 4_000_000;
  let pre: Int32Array = new Int32Array(cap);
  let post: Int32Array = new Int32Array(cap);
  let syn: Int32Array = new Int32Array(cap);
  let M = 0;
  let rows = 0;
  let skipped = 0;
  for await (const line of gzLines(join(o.rawDir, 'connections.csv.gz'))) {
    rows++;
    const c = line.split(',');
    const a = canon.get(c[0]!);
    const b = canon.get(c[1]!);
    if (a === undefined || b === undefined) {
      skipped++;
      continue;
    }
    const i = newIdx[a]!;
    const j = newIdx[b]!;
    if (i < 0 || j < 0) continue; // outside the region
    if (M === cap) {
      cap *= 2;
      pre = grow(pre, cap);
      post = grow(post, cap);
      syn = grow(syn, cap);
    }
    const nt = c[4];
    pre[M] = i;
    post[M] = j;
    syn[M] = (nt === 'GABA' || nt === 'GLUT' ? -1 : 1) * Number(c[3]);
    M++;
  }
  o.log.info(`connections: ${rows} rows, ${M} in region, ${skipped} with unknown root id (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 5. bucket by post (CSR), then per row: sort by pre, merge duplicates, drop zero sums
  const rowPtr0 = new Int32Array(N + 1);
  for (let k = 0; k < M; k++) {
    const r = post[k]! + 1;
    rowPtr0[r] = rowPtr0[r]! + 1;
  }
  for (let i = 0; i < N; i++) rowPtr0[i + 1] = rowPtr0[i + 1]! + rowPtr0[i]!;
  const fill = rowPtr0.slice(0, N);
  const col0 = new Int32Array(M);
  const val0 = new Int32Array(M);
  for (let k = 0; k < M; k++) {
    const r = post[k]!;
    const p = fill[r]!;
    fill[r] = p + 1;
    col0[p] = pre[k]!;
    val0[p] = syn[k]!;
  }
  const rowPtr = new Int32Array(N + 1);
  const colIdx = new Int32Array(M);
  const raw = new Int16Array(M);
  let E = 0;
  let pairs = 0;
  for (let r = 0; r < N; r++) {
    const a = rowPtr0[r]!;
    const b = rowPtr0[r + 1]!;
    if (b > a) {
      const idx = Array.from({ length: b - a }, (_, k) => a + k).sort((x, y) => col0[x]! - col0[y]!);
      let k = 0;
      while (k < idx.length) {
        const col = col0[idx[k]!]!;
        let sum = 0;
        while (k < idx.length && col0[idx[k]!] === col) sum += val0[idx[k++]!]!;
        pairs++;
        if (sum === 0) continue;
        colIdx[E] = col;
        raw[E] = Math.max(-32767, Math.min(32767, sum));
        E++;
      }
    }
    rowPtr[r + 1] = E;
  }

  const nt = new Uint8Array(N);
  const ids = new BigUint64Array(N);
  order.forEach((old, i) => {
    nt[i] = nt0[old]!;
    ids[i] = rootIds[old]!;
  });
  const meta: ConnectomeMeta = {
    format: 1,
    dataset: 'fafb-v783',
    region: o.region,
    N,
    E,
    populations,
    ntSign: 'shiu',
    builtAt: new Date().toISOString(),
    sources: [...RAW_FILES],
    stats: { neuronsTotal: N0, connectionRows: rows, rowsInRegion: M, pairs, unknownRootIdRows: skipped },
  };
  const conn = new Connectome(meta, rowPtr, colIdx.slice(0, E), raw.slice(0, E), nt, ids);
  conn.save(o.outPath);
  o.log.ok(`wrote ${o.outPath}: N=${N} E=${E} (${pairs} pairs, ${pairs - E} zero-sum dropped) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return conn;
}

function grow(a: Int32Array, cap: number): Int32Array {
  const b = new Int32Array(cap);
  b.set(a);
  return b;
}
