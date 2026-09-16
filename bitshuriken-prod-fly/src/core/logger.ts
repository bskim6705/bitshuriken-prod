/** Minimal timestamped stderr logger with per-scope tags. */
const C = { dim: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', reset: '\x1b[0m' };

function ts(): string {
  const d = new Date();
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function makeLogger(scope: string) {
  const tag = `${C.cyan}[${scope}]${C.reset}`;
  return {
    info: (...a: unknown[]) => console.error(`${C.dim}${ts()}${C.reset} ${tag}`, ...a),
    ok: (...a: unknown[]) => console.error(`${C.dim}${ts()}${C.reset} ${tag} ${C.green}✓${C.reset}`, ...a),
    warn: (...a: unknown[]) => console.error(`${C.dim}${ts()}${C.reset} ${tag} ${C.yellow}!${C.reset}`, ...a),
    err: (...a: unknown[]) => console.error(`${C.dim}${ts()}${C.reset} ${tag} ${C.red}✗${C.reset}`, ...a),
  };
}

export type Logger = ReturnType<typeof makeLogger>;
