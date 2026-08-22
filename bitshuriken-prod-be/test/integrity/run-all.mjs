// Runs every live integrity suite as a child process, aggregates REPORT_JSON, prints a summary.
// Usage: node test/integrity/run-all.mjs   (services must be running; see test/integrity/README.md)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const SUITES = ['spot.mjs', 'portal.mjs', 'futures.mjs'];
const results = [];
for (const s of SUITES) {
  process.stdout.write(`\n===== ${s} =====\n`);
  let stdout = '';
  try { ({ stdout } = await run('node', [new URL(s, import.meta.url).pathname], { maxBuffer: 10 * 1024 * 1024 })); }
  catch (e) { stdout = (e.stdout || '') + (e.stderr || ''); }
  const line = stdout.split('\n').find((l) => l.startsWith('REPORT_JSON '));
  if (line) { const r = JSON.parse(line.slice('REPORT_JSON '.length)); results.push(r); console.log(`${r.suite}: ${r.passed}/${r.total}${r.failed ? ` (${r.failed} FAILED)` : ''}`); }
  else { results.push({ suite: s, total: 0, passed: 0, failed: 1, error: 'no REPORT_JSON' }); console.log(`${s}: NO REPORT (crash?)`); }
}
const total = results.reduce((a, r) => a + r.total, 0), passed = results.reduce((a, r) => a + r.passed, 0), failed = results.reduce((a, r) => a + r.failed, 0);
console.log('\n========================================');
for (const r of results) console.log(`  ${r.failed ? 'FAIL' : 'PASS'}  ${r.suite}: ${r.passed}/${r.total}`);
console.log(`  TOTAL: ${passed}/${total} passed${failed ? `, ${failed} FAILED` : ''}`);
console.log('========================================');
process.exit(failed ? 1 : 0);
