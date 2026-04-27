/**
 * @file pg.ts
 * @description Postgres connection pool singleton for the public-api service.
 *
 * Connects through the in-cluster PgBouncer service
 * (`pgbouncer.platform.svc.cluster.local:5432`) using credentials synced
 * from the `platform-rds-credentials` ESO secret. Permissive SSL — RDS sits
 * within the VPC and the certificate chain is not validated client-side.
 */

import { Pool } from 'pg';
import type { Config } from './config.js';

let _pool: Pool | undefined;

export function getPool(config: Config): Pool {
    if (!_pool) {
        _pool = new Pool({
            host:     config.pgHost,
            port:     config.pgPort,
            database: config.pgDatabase,
            user:     config.pgUser,
            password: config.pgPassword,
            ssl:      { rejectUnauthorized: false },
            max:      5,
            idleTimeoutMillis:       30_000,
            connectionTimeoutMillis: 5_000,
        });
    }
    return _pool;
}

export function _resetPool(): void { _pool = undefined; }
