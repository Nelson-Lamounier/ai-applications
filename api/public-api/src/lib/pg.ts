/**
 * @file pg.ts
 * @description Postgres connection pool singleton for the public-api service.
 *
 * Connects through the in-cluster PgBouncer service
 * (`pgbouncer.platform.svc.cluster.local:5432`) using credentials synced
 * from the `platform-rds-credentials` ESO secret. SSL is disabled on the
 * client hop: PgBouncer runs with `client_tls_sslmode=disable`, so requesting
 * SSL makes the driver fail with "The server does not support SSL connections".
 * TLS to RDS is terminated by PgBouncer on the server hop. This matches the
 * shared RDS repositories (RdsSyncStateRepository / RdsVectorStore), which also
 * set `ssl: false` for the PgBouncer connection.
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
            ssl:      false,
            max:      5,
            idleTimeoutMillis:       30_000,
            connectionTimeoutMillis: 5_000,
        });
    }
    return _pool;
}

export function _resetPool(): void { _pool = undefined; }
