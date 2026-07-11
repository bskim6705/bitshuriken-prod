import pg from 'pg';
import { config } from '../config';

export type Status = 'pass' | 'warn' | 'fail';
export interface CheckResult {
  name: string;
  status: Status;
  detail: string;
  samples?: string[];
}

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is required for the integrity checker (npm run check)');
}
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 3 });

export async function closeDb(): Promise<void> {
  await pool.end();
}

export async function rows<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await pool.query<T>(sql, params);
  return r.rows;
}

export const worst = (results: CheckResult[]): Status =>
  results.some((r) => r.status === 'fail') ? 'fail' : results.some((r) => r.status === 'warn') ? 'warn' : 'pass';
