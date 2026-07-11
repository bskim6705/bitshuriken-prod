import { closeDb, type CheckResult } from './db';
import { runInvariants } from './invariants';
import { runFutures } from './futures';
import { liquidationOracle } from './liquidation';
import { runParity } from './parity';

const C = { dim: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m', reset: '\x1b[0m' };
const icon = (s: CheckResult['status']) =>
  s === 'pass' ? `${C.green}✓${C.reset}` : s === 'warn' ? `${C.yellow}!${C.reset}` : `${C.red}✗${C.reset}`;

function printSection(title: string, results: CheckResult[]): void {
  console.log(`${C.bold}${title}${C.reset}`);
  for (const r of results) {
    console.log(`  ${icon(r.status)} ${r.name} ${C.dim}—${C.reset} ${r.detail}`);
    for (const s of r.samples ?? []) console.log(`      ${C.dim}· ${s}${C.reset}`);
  }
}

async function once(): Promise<boolean> {
  const [inv, fut, liq, par] = await Promise.all([
    runInvariants(),
    runFutures(),
    liquidationOracle().then((r) => [r]),
    runParity(),
  ]);
  const money = [...inv, ...fut, ...liq];
  const all = [...money, ...par];
  const fails = all.filter((r) => r.status === 'fail').length;
  const warns = all.filter((r) => r.status === 'warn').length;

  console.log(`\n${C.bold}═══ bitshuriken monetary integrity — ${new Date().toTimeString().slice(0, 8)} ═══${C.reset}`);
  printSection('F1/F4 SPOT LEDGER & LOCKS', inv);
  printSection('F3 FUTURES PnL & LEDGER', fut);
  printSection('F2 LIQUIDATION ORACLE', liq);
  printSection('PARITY (local book vs source — informational)', par);
  const verdict = fails ? `${C.red}FAIL${C.reset}` : warns ? `${C.yellow}PASS (warnings)${C.reset}` : `${C.green}PASS${C.reset}`;
  console.log(`${C.bold}RESULT: ${verdict}${C.reset}  ${C.dim}(${fails} fail, ${warns} warn)${C.reset}`);
  // A monetary fail (F1-F4) exits non-zero; parity warnings never fail the run.
  return fails === 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const watch = args.includes('--watch');
  const intervalArg = args.find((a) => a.startsWith('--interval='));
  const intervalMs = intervalArg ? Number(intervalArg.split('=')[1]) * 1000 : 5000;

  if (!watch) {
    const ok = await once();
    await closeDb();
    process.exit(ok ? 0 : 1);
  }

  let stop = false;
  process.on('SIGINT', () => {
    stop = true;
  });
  while (!stop) {
    try {
      await once();
    } catch (e) {
      console.error('check error:', e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  await closeDb();
  process.exit(0);
}

void main();
