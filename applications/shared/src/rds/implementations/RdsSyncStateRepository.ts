/**
 * @format
 * RdsSyncStateRepository — ISyncStateRepository backed by RDS PostgreSQL
 *
 * All operations target the repo_sync_state table.
 * Single responsibility: sync state persistence — no vector operations.
 */

import type { ISyncStateRepository } from '../interfaces/ISyncStateRepository.js';
import type { RepoSyncState, SyncStatus } from '../types.js';
import type { RdsClientConfig } from './RdsVectorStore.js';
import { Pool } from 'pg';

// =============================================================================
// ROW SHAPE
// =============================================================================

interface SyncStateRow {
    sync_status:          string;
    last_synced_at:       Date | null;
    file_count:           number;
    chunk_count:          number;
    error_message:        string | null;
    kb_quality_score:     string | number | null;        // pg returns NUMERIC as string
    kb_quality_breakdown: Record<string, unknown> | null;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class RdsSyncStateRepository implements ISyncStateRepository {
    private readonly pool: Pool;

    constructor(config: RdsClientConfig) {
        this.pool = new Pool({
            host:               config.host,
            port:               config.port,
            database:           config.database,
            user:               config.user,
            password:           config.password,
            max:                5,
            idleTimeoutMillis:  30_000,
            // PgBouncer runs with client_tls_sslmode=disable — no SSL on the
            // client→PgBouncer leg. PgBouncer handles the PgBouncer→RDS leg.
            ssl:                false,
        });
    }

    static fromEnvironment(): RdsSyncStateRepository {
        const host     = process.env.RDS_HOST;
        const port     = process.env.RDS_PORT;
        const database = process.env.RDS_DB_NAME;
        const user     = process.env.RDS_USER;
        const password = process.env.RDS_PASSWORD;

        if (!host || !port || !database || !user || !password) {
            throw new Error(
                'RdsSyncStateRepository: missing environment variables. ' +
                'Required: RDS_HOST, RDS_PORT, RDS_DB_NAME, RDS_USER, RDS_PASSWORD',
            );
        }

        return new RdsSyncStateRepository({ host, port: parseInt(port, 10), database, user, password });
    }

    /** Release all pool connections. Call on graceful shutdown if needed. */
    async end(): Promise<void> {
        await this.pool.end();
    }

    // =========================================================================
    // ISyncStateRepository.get
    // =========================================================================

    async get(userId: string, repoFullName: string): Promise<RepoSyncState | undefined> {
        const result = await this.pool.query<SyncStateRow>(
            `SELECT sync_status, last_synced_at, file_count, chunk_count, error_message,
                    kb_quality_score, kb_quality_breakdown
             FROM repo_sync_state
             WHERE user_id = $1 AND repo_full_name = $2`,
            [userId, repoFullName],
        );

        if (result.rows.length === 0) return undefined;

        const row = result.rows[0];
        const score = row.kb_quality_score == null
            ? undefined
            : typeof row.kb_quality_score === 'string'
                ? parseFloat(row.kb_quality_score)
                : row.kb_quality_score;

        return {
            userId,
            repoFullName,
            syncStatus:         row.sync_status as SyncStatus,
            lastSyncedAt:       row.last_synced_at ?? undefined,
            fileCount:          row.file_count,
            chunkCount:         row.chunk_count,
            errorMessage:       row.error_message ?? undefined,
            kbQualityScore:     score,
            kbQualityBreakdown: row.kb_quality_breakdown ?? undefined,
        };
    }

    // =========================================================================
    // ISyncStateRepository.upsert
    // =========================================================================

    async upsert(state: RepoSyncState): Promise<void> {
        await this.pool.query(
            `INSERT INTO repo_sync_state (
                user_id, repo_full_name, sync_status,
                last_synced_at, file_count, chunk_count, error_message,
                kb_quality_score, kb_quality_breakdown
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
            ON CONFLICT (user_id, repo_full_name)
            DO UPDATE SET
                sync_status          = EXCLUDED.sync_status,
                last_synced_at       = EXCLUDED.last_synced_at,
                file_count           = EXCLUDED.file_count,
                chunk_count          = EXCLUDED.chunk_count,
                error_message        = EXCLUDED.error_message,
                kb_quality_score     = EXCLUDED.kb_quality_score,
                kb_quality_breakdown = EXCLUDED.kb_quality_breakdown`,
            [
                state.userId,
                state.repoFullName,
                state.syncStatus,
                state.lastSyncedAt ?? null,
                state.fileCount,
                state.chunkCount,
                state.errorMessage ?? null,
                state.kbQualityScore ?? null,
                state.kbQualityBreakdown == null
                    ? null
                    : JSON.stringify(state.kbQualityBreakdown),
            ],
        );
    }

    // =========================================================================
    // ISyncStateRepository shorthands
    // =========================================================================

    async markStarted(userId: string, repoFullName: string): Promise<void> {
        return this.upsert({
            userId,
            repoFullName,
            syncStatus: 'syncing',
            fileCount:  0,
            chunkCount: 0,
        });
    }

    async markComplete(
        userId: string,
        repoFullName: string,
        fileCount: number,
        chunkCount: number,
        kbQualityScore?: number,
        kbQualityBreakdown?: Record<string, unknown>,
    ): Promise<void> {
        return this.upsert({
            userId,
            repoFullName,
            syncStatus:    'complete',
            lastSyncedAt:  new Date(),
            fileCount,
            chunkCount,
            kbQualityScore,
            kbQualityBreakdown,
        });
    }

    async markError(
        userId: string,
        repoFullName: string,
        errorMessage: string,
    ): Promise<void> {
        return this.upsert({
            userId,
            repoFullName,
            syncStatus:   'error',
            lastSyncedAt: new Date(),
            fileCount:    0,
            chunkCount:   0,
            errorMessage,
        });
    }
}
