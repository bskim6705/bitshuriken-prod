import { readFileSync, writeFileSync } from 'node:fs';
import type { Population } from './populations';

/** neurons.csv nt_type 코드. 0 = 예측 없음. */
export const NT_CODES = ['', 'ACH', 'GABA', 'GLUT', 'DA', 'SER', 'OCT'] as const;

export interface PopRange {
  name: Population;
  start: number;
  end: number; // exclusive
}

export interface ConnectomeMeta {
  format: 1;
  dataset: 'fafb-v783';
  region: 'central' | 'full';
  N: number;
  E: number;
  populations: PopRange[];
  /** Shiu et al. 2024: GABA·glutamate 억제(−), 그 외 흥분(+). 시냅스 수를 neuropil 합산. */
  ntSign: 'shiu';
  builtAt: string;
  sources: string[];
  stats: Record<string, number>;
}

const MAGIC = 'FLYB';
const align8 = (n: number): number => (n + 7) & ~7;

/**
 * 커넥톰 = post-major CSR. 뉴런 i의 입력 시냅스는 colIdx[rowPtr[i]..rowPtr[i+1]) (pre 인덱스)와
 * raw[..] (부호 붙은 시냅스 수). 부호·위상은 고정, 크기 정규화만 런타임 선택.
 */
export class Connectome {
  constructor(
    readonly meta: ConnectomeMeta,
    readonly rowPtr: Int32Array,
    readonly colIdx: Int32Array,
    readonly raw: Int16Array,
    readonly nt: Uint8Array,
    readonly rootIds: BigUint64Array,
  ) {}

  get N(): number {
    return this.meta.N;
  }
  get E(): number {
    return this.meta.E;
  }

  range(name: Population): PopRange {
    const r = this.meta.populations.find((p) => p.name === name);
    if (!r) throw new Error(`connectome has no population ${name}`);
    return r;
  }

  /**
   * 뉴런별 입력 크기 정규화 — Lp 노름: w = raw / (Σ|raw|^p)^(1/p).
   * p=1: Σ|w|=1, 입력이 가중 평균이라 부호가 섞이면 깊은 층에서 활동이 소멸하지만 gain<1이면 수축 사상(echo state 보장).
   * p=2: Σw²=1, 무작위 부호 입력의 분산이 층을 지나도 보존되지만 허브(수천 입력)가 폭주해 다중 안정 상태가 생긴다.
   */
  normalizedWeights(p = 1): Float32Array {
    const w = new Float32Array(this.E);
    for (let i = 0; i < this.N; i++) {
      const a = this.rowPtr[i]!;
      const b = this.rowPtr[i + 1]!;
      let sum = 0;
      for (let e = a; e < b; e++) sum += Math.abs(this.raw[e]!) ** p;
      if (sum === 0) continue;
      const norm = sum ** (1 / p);
      for (let e = a; e < b; e++) w[e] = this.raw[e]! / norm;
    }
    return w;
  }

  save(path: string): void {
    const metaBuf = Buffer.from(JSON.stringify(this.meta), 'utf8');
    const header = Buffer.alloc(8);
    header.write(MAGIC, 0, 'ascii');
    header.writeUInt32LE(metaBuf.length, 4);
    const sections: Buffer[] = [header, metaBuf, pad(8 + metaBuf.length)];
    for (const arr of [this.rowPtr, this.colIdx, this.raw, this.nt, this.rootIds] as ArrayBufferView[]) {
      sections.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength), pad(arr.byteLength));
    }
    writeFileSync(path, Buffer.concat(sections));
  }

  static load(path: string): Connectome {
    const file = readFileSync(path);
    if (file.toString('ascii', 0, 4) !== MAGIC) throw new Error(`${path}: not a flybrain connectome`);
    const metaLen = file.readUInt32LE(4);
    const meta = JSON.parse(file.toString('utf8', 8, 8 + metaLen)) as ConnectomeMeta;
    if (meta.format !== 1) throw new Error(`${path}: unsupported format ${String(meta.format)}`);
    // typed-array views need 8-byte alignment → copy into a fresh ArrayBuffer
    const ab = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
    let off = align8(8 + metaLen);
    const take = <T extends ArrayBufferView>(make: (buf: ArrayBuffer, off: number, len: number) => T, len: number, bytesPer: number): T => {
      const v = make(ab, off, len);
      off = align8(off + len * bytesPer);
      return v;
    };
    const rowPtr = take((b, o, l) => new Int32Array(b, o, l), meta.N + 1, 4);
    const colIdx = take((b, o, l) => new Int32Array(b, o, l), meta.E, 4);
    const raw = take((b, o, l) => new Int16Array(b, o, l), meta.E, 2);
    const nt = take((b, o, l) => new Uint8Array(b, o, l), meta.N, 1);
    const rootIds = take((b, o, l) => new BigUint64Array(b, o, l), meta.N, 8);
    return new Connectome(meta, rowPtr, colIdx, raw, nt, rootIds);
  }
}

function pad(len: number): Buffer {
  return Buffer.alloc(align8(len) - len);
}
