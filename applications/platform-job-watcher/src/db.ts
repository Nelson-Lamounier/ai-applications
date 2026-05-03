import { Pool } from 'pg';
import type { DbConfig } from './config.js';

let pool: Pool | undefined;

export function getPool(cfg: DbConfig): Pool {
  if (!pool) {
    pool = new Pool({
      host:                    cfg.host,
      port:                    cfg.port,
      database:                cfg.database,
      user:                    cfg.user,
      password:                cfg.password,
      ssl:                     false,
      max:                     3,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export function _resetPool(): void {
  pool = undefined;
}
