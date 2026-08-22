import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { StrategyFactory } from './types';
import { makeLogger } from '../core/logger';

const log = makeLogger('registry');
const STRATEGIES_DIR = fileURLToPath(new URL('../strategies/', import.meta.url));

/** Holds the loaded strategy factories. The LLM authors a new file then calls reload(). */
export class StrategyRegistry {
  private readonly factories = new Map<string, StrategyFactory>();

  list(): StrategyFactory[] {
    return [...this.factories.values()];
  }

  get(id: string): StrategyFactory | undefined {
    return this.factories.get(id);
  }

  /** load (or reload) every src/strategies/*.ts. Cache-busts so edited files re-import. */
  async loadAll(): Promise<string[]> {
    const files = readdirSync(STRATEGIES_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
    const loaded: string[] = [];
    for (const f of files) loaded.push(...(await this.loadFile(f)));
    return loaded;
  }

  /** load (or reload) a single strategy module by file name (e.g. "momentum.ts"). */
  async loadFile(file: string): Promise<string[]> {
    const url = pathToFileURL(join(STRATEGIES_DIR, file)).href + `?v=${Date.now()}`;
    const mod = (await import(url)) as { default?: unknown };
    const factory = mod.default;
    if (!isFactory(factory)) {
      throw new Error(`${file}: default export is not a StrategyFactory ({id, paramSchema, create})`);
    }
    this.factories.set(factory.id, factory);
    log.ok(`registered strategy "${factory.id}" from ${file}`);
    return [factory.id];
  }
}

function isFactory(x: unknown): x is StrategyFactory {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as StrategyFactory).id === 'string' &&
    typeof (x as StrategyFactory).create === 'function' &&
    typeof (x as StrategyFactory).paramSchema === 'object'
  );
}
