import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { lobDir } from '../brain/paths';
import type { LobSample } from './sample';

/** 기록 간격이 이보다 크면 별 세그먼트 — 피처·뇌 상태를 리셋하고 타깃도 경계를 넘지 않는다. */
export const GAP_MS = 60_000;

/** data/lob/<SYMBOL>/*.jsonl 전부 → 시간순 샘플. */
export function loadRecording(symbol: string, opts: { from?: number; to?: number } = {}): LobSample[] {
  const dir = lobDir(symbol);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  const out: LobSample[] = [];
  let lastT = -1;
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let s: LobSample;
      try {
        s = JSON.parse(line) as LobSample;
      } catch {
        continue; // 잘린 마지막 줄 (기록 중)
      }
      if (opts.from !== undefined && s.t < opts.from) continue;
      if (opts.to !== undefined && s.t > opts.to) continue;
      if (s.t <= lastT) continue;
      lastT = s.t;
      out.push(s);
    }
  }
  return out;
}

export function describeRecording(samples: LobSample[]): { rows: number; from: number; to: number; hours: number; segments: number } {
  if (!samples.length) return { rows: 0, from: 0, to: 0, hours: 0, segments: 0 };
  let segments = 1;
  for (let i = 1; i < samples.length; i++) if (samples[i]!.t - samples[i - 1]!.t > GAP_MS) segments++;
  return { rows: samples.length, from: samples[0]!.t, to: samples[samples.length - 1]!.t, hours: samples.length / 3600, segments };
}
