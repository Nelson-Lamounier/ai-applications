/**
 * @format
 * RdsSyncStateRepository — ISyncStateRepository backed by RDS PostgreSQL
 *
 * All operations target the repo_sync_state table.
 * Single responsibility: sync state persistence — no vector operations.
 */

import type { ISyncStateRepository } from '../interfaces/ISyncStateRepository.js';
import type { RepoSyncState, SyncStatus, IngestionPhase } from '../types.js';
import type { RdsClientConfig } from './RdsVectorStore.js';
import { Pool } from 'pg';

// =============================================================================
// ROW SHAPE
// =============================================================================

interface SyncStateRow {
    sync_status:           string;
    last_synced_at:        Date | null;
    file_count:            number;
    chunk_count:           number;
    error_message:         string | null;
    kb_quality_score:      string | number | null;        // pg returns NUMERIC as string
    kb_quality_breakdown:  Record<string, unknown> | null;
    retrieval_score:       string | number | null;        // pg returns NUMERIC as string
    retrieval_breakdown:   Record<string, unknown> | null;
    embedded_count:        number | null;
    embed_total:           number | null;
    phase:                 string | null;
    phase_done:            number | null;
    phase_total:           number | null;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class RdsSyncStateRepository implements ISyncStateRepository {
    private readonly pool: Pool;
    /**
     * Immutable GitHub numeric repo id, dual-written onto every repo_sync_state
     * upsert so a rename is a metadata update (reconcileRepoName) rather than a
     * re-ingest. Null on legacy/pre-backfill runs — the column is nullable and a
     * later id-bearing run / the backfill fills it.
     */
    private readonly githubRepoId: number | null;

    constructor(config: RdsClientConfig, githubRepoId: number | null = null) {
        this.githubRepoId = githubRepoId;
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
                    kb_quality_score, kb_quality_breakdown,
                    retrieval_score, retrieval_breakdown,
                    embedded_count, embed_total,
                    phase, phase_done, phase_total
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

        const retrievalScore = row.retrieval_score == null
            ? undefined
            : typeof row.retrieval_score === 'string'
                ? parseFloat(row.retrieval_score)
                : row.retrieval_score;

        return {
            userId,
            repoFullName,
            syncStatus:          row.sync_status as SyncStatus,
            lastSyncedAt:        row.last_synced_at ?? undefined,
            fileCount:           row.file_count,
            chunkCount:          row.chunk_count,
            errorMessage:        row.error_message ?? undefined,
            kbQualityScore:      score,
            kbQualityBreakdown:  row.kb_quality_breakdown ?? undefined,
            retrievalScore,
            retrievalBreakdown:  row.retrieval_breakdown ?? undefined,
            embeddedCount:       row.embedded_count ?? undefined,
            embedTotal:          row.embed_total ?? undefined,
            phase:               (row.phase as IngestionPhase | null) ?? undefined,
            phaseDone:           row.phase_done ?? undefined,
            phaseTotal:          row.phase_total ?? undefined,
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
                kb_quality_score, kb_quality_breakdown,
                retrieval_score, retrieval_breakdown, github_repo_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12)
            ON CONFLICT (user_id, repo_full_name)
            DO UPDATE SET
                sync_status           = EXCLUDED.sync_status,
                last_synced_at        = EXCLUDED.last_synced_at,
                file_count            = EXCLUDED.file_count,
                chunk_count           = EXCLUDED.chunk_count,
                error_message         = EXCLUDED.error_message,
                kb_quality_score      = COALESCE(EXCLUDED.kb_quality_score, repo_sync_state.kb_quality_score),
                kb_quality_breakdown  = COALESCE(EXCLUDED.kb_quality_breakdown, repo_sync_state.kb_quality_breakdown),
                retrieval_score       = COALESCE(EXCLUDED.retrieval_score, repo_sync_state.retrieval_score),
                retrieval_breakdown   = COALESCE(EXCLUDED.retrieval_breakdown, repo_sync_state.retrieval_breakdown),
                github_repo_id        = COALESCE(EXCLUDED.github_repo_id, repo_sync_state.github_repo_id)`,
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
                state.retrievalScore ?? null,
                state.retrievalBreakdown == null
                    ? null
                    : JSON.stringify(state.retrievalBreakdown),
                this.githubRepoId,
            ],
        );
    }

    // =========================================================================
    // ISyncStateRepository shorthands
    // =========================================================================

    async markStarted(userId: string, repoFullName: string): Promise<void> {
        await this.upsert({
            userId,
            repoFullName,
            syncStatus: 'syncing',
            fileCount:  0,
            chunkCount: 0,
        });
    }

    /**
     * Begin a run: set status='syncing' and reset stale phase/progress so a
     * re-ingest doesn't briefly show last run's "embedded N/N". Call once at
     * the very start (run-ingestion), before any markPhase. Idempotent.
     */
    async beginRun(userId: string, repoFullName: string): Promise<void> {
        await this.markStarted(userId, repoFullName);
        await this.pool.query(
            `UPDATE repo_sync_state
                SET embedded_count = NULL, embed_total = NULL,
                    phase = NULL, phase_done = NULL, phase_total = NULL
              WHERE user_id = $1 AND repo_full_name = $2`,
            [userId, repoFullName],
        );
    }

    async markPhase(
        userId: string,
        repoFullName: string,
        phase: IngestionPhase,
        done?: number,
        total?: number,
    ): Promise<void> {
        // Targeted UPDATE — touches only the phase columns so it can't race
        // with the quality/retrieval fields written by markComplete. No-op if
        // the row doesn't exist yet (markStarted/markPhase('analyzing') first).
        await this.pool.query(
            `UPDATE repo_sync_state
                SET phase = $3, phase_done = $4, phase_total = $5
              WHERE user_id = $1 AND repo_full_name = $2`,
            [userId, repoFullName, phase, done ?? null, total ?? null],
        );
    }

    /**
     * Persist the derived 46-signal archetype map onto the existing
     * repo_sync_state row. Mirrors markPhase exactly: a single targeted UPDATE
     * via the pool (no explicit txn / set_config — relies on the same pre-set
     * RLS GUC as the other write methods). No-op safe: if the row doesn't yet
     * exist the UPDATE affects 0 rows.
     */
    async saveArchetypeSignals(
        userId: string,
        repoFullName: string,
        signals: Record<string, boolean>,
    ): Promise<void> {
        await this.pool.query(
            `UPDATE repo_sync_state
                SET archetype_signals = $3::jsonb
              WHERE user_id = $1 AND repo_full_name = $2`,
            [userId, repoFullName, JSON.stringify(signals)],
        );
    }

    /**
     * Persist the deterministic evidence topology (package.json scripts + DB
     * migration ecosystem + monorepo) for a repo. Same write shape as
     * saveArchetypeSignals. No-op safe when the row doesn't yet exist.
     */
    async saveEvidenceTopology(
        userId: string,
        repoFullName: string,
        topology: Record<string, unknown>,
    ): Promise<void> {
        await this.pool.query(
            `UPDATE repo_sync_state
                SET evidence_topology = $3::jsonb
              WHERE user_id = $1 AND repo_full_name = $2`,
            [userId, repoFullName, JSON.stringify(topology)],
        );
    }

    /**
     * Read the last-synced commit SHA watermark. Plain pool.query (mirrors
     * markPhase/saveArchetypeSignals — no explicit txn / set_config; relies on
     * the pool's pre-set RLS GUC). Returns null when no row exists or the
     * column is NULL.
     */
    async getLastSyncedCommitSha(userId: string, repoFullName: string): Promise<string | null> {
        const { rows } = await this.pool.query<{ last_synced_commit_sha: string | null }>(
            `SELECT last_synced_commit_sha FROM repo_sync_state
              WHERE user_id = $1 AND repo_full_name = $2`,
            [userId, repoFullName],
        );
        return rows[0]?.last_synced_commit_sha ?? null;
    }

    /**
     * Persist the last-synced commit SHA watermark. Mirrors markPhase exactly:
     * a single targeted UPDATE via the pool (no explicit txn / set_config). No-op
     * safe: if the row doesn't yet exist the UPDATE affects 0 rows.
     */
    async setLastSyncedCommitSha(userId: string, repoFullName: string, sha: string): Promise<void> {
        await this.pool.query(
            `UPDATE repo_sync_state SET last_synced_commit_sha = $3
              WHERE user_id = $1 AND repo_full_name = $2`,
            [userId, repoFullName, sha],
        );
    }

    async markComplete(
        userId: string,
        repoFullName: string,
        fileCount: number,
        chunkCount: number,
        kbQualityScore?: number,
        kbQualityBreakdown?: Record<string, unknown>,
        retrievalScore?: number,
        retrievalBreakdown?: Record<string, unknown>,
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
            retrievalScore,
            retrievalBreakdown,
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
