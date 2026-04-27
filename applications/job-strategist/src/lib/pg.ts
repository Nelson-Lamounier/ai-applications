/**
 * @format
 * Postgres connection pool singleton for the Strategist analysis K8s Job.
 *
 * Mirrors the pattern used by platform-rds-bootstrap: small max pool,
 * permissive SSL (RDS in-VPC), bounded connect timeout.
 */
import { Pool } from 'pg';

export interface PgConfig {
    readonly host:     string;
    readonly port:     number;
    readonly database: string;
    readonly user:     string;
    readonly password: string;
}

let pool: Pool | undefined;

export function getPool(cfg: PgConfig): Pool {
    if (!pool) {
        pool = new Pool({
            host:                    cfg.host,
            port:                    cfg.port,
            database:                cfg.database,
            user:                    cfg.user,
            password:                cfg.password,
            ssl:                     { rejectUnauthorized: false },
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
