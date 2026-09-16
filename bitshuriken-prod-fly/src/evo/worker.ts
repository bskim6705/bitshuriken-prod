import { readFileSync, writeFileSync } from 'node:fs';
import { Connectome } from '../brain/connectome';
import { connectomePath } from '../brain/paths';
import { loadRecording } from '../lob/replay';
import { evaluate, type EvalOptions } from './evaluate';
import type { Genome } from './genome';

/** 자식 프로세스: `worker <genome.json> <result.json> <symbol> <opts.json>` — 파리 하나 평가. */
const [genomePath, resultPath, symbol, optsJson] = process.argv.slice(2);
if (!genomePath || !resultPath || !symbol || !optsJson) {
  console.error('usage: worker <genome.json> <result.json> <symbol> <opts.json>');
  process.exit(2);
}
const g = JSON.parse(readFileSync(genomePath, 'utf8')) as Genome;
const opts = JSON.parse(optsJson) as EvalOptions & { region: 'central' | 'full'; from?: number; to?: number };
const conn = Connectome.load(connectomePath(opts.region));
const samples = loadRecording(symbol, { from: opts.from, to: opts.to });
const res = evaluate(g, conn, samples, opts);
writeFileSync(resultPath, JSON.stringify(res));
