/**
 * @format
 * RdsVectorStore — IVectorStore backed by RDS PostgreSQL + pgvector
 *
 * SQL runs via node-postgres (pg) Pool over TCP — Lambda must be VPC-resident.
 * Each public method is a single responsibility: one SQL operation per method.
 *
 * Upsert ordering:
 *   Sequential — not parallel. Preserve this until RDS connection pool is
 *   validated under full repo scan load. Parallelise (p-limit 5) only after
 *   measuring that the pool handles concurrent requests without timeout.
 */

import { Pool, type QueryResult } from 'pg';

import type { IVectorStore } from '../interfaces/IVectorStore.js';
import type {
    ChunkIdentity,
    DocumentChunk,
    HashCheckResult,
    QueryParams,
    SimilarityResult,
    UpsertBatchResult,
} from '../types.js';

// =============================================================================
// CONFIG
// =============================================================================

export interface RdsClientConfig {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
}

// =============================================================================
// ROW SHAPES (pg returns column names as keys)
// =============================================================================

interface UpsertRow      { was_inserted: boolean }
interface SimilarityRow  {
    id: string;
    repo_full_name: string;
    file_path: string;
    heading: string | null;
    content: string;
    chunk_index: number;
    tags: string[];
    similarity: number;
}
interface HashCheckRow   {
    file_path: string;
    chunk_index: number;
    candidate_hash: string;
    stored_hash: string | null;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Convert string[] to a PostgreSQL array literal.
 * '{aws,kubernetes,ci-cd}' — no commas or spaces in individual tags.
 */
function toPostgresArray(tags: string[]): string {
    return `{${tags.join(',')}}`;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class RdsVectorStore implements IVectorStore {
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
            ssl:                { rejectUnauthorized: false },
        });
    }

    /**
     * Resolve config from Lambda environment variables.
     * Lambda handler is responsible for resolving RDS_PASSWORD from
     * Secrets Manager before cold start completes.
     */
    static fromEnvironment(): RdsVectorStore {
        const host     = process.env.RDS_HOST;
        const port     = process.env.RDS_PORT;
        const database = process.env.RDS_DB_NAME;
        const user     = process.env.RDS_USER;
        const password = process.env.RDS_PASSWORD;

        if (!host || !port || !database || !user || !password) {
            throw new Error(
                'RdsVectorStore: missing environment variables. ' +
                'Required: RDS_HOST, RDS_PORT, RDS_DB_NAME, RDS_USER, RDS_PASSWORD',
            );
        }

        return new RdsVectorStore({ host, port: parseInt(port, 10), database, user, password });
    }

    /** Release all pool connections. Call on graceful shutdown if needed. */
    async end(): Promise<void> {
        await this.pool.end();
    }

    // =========================================================================
    // IVectorStore.upsertBatch
    // =========================================================================

    async upsertBatch(chunks: DocumentChunk[]): Promise<UpsertBatchResult> {
        if (chunks.length === 0) {
            return { inserted: 0, updated: 0, skipped: 0, errors: 0 };
        }

        let inserted = 0, updated = 0, skipped = 0, errors = 0;

        for (const chunk of chunks) {
            try {
                const outcome = await this.upsertOne(chunk);
                if (outcome === 'inserted') inserted++;
                else if (outcome === 'updated') updated++;
                else skipped++;
            } catch (err) {
                console.error(
                    `[RdsVectorStore.upsertBatch] error on ` +
                    `${chunk.repoFullName}:${chunk.filePath}#${chunk.chunkIndex}:`,
                    err,
                );
                errors++;
            }
        }

        return { inserted, updated, skipped, errors };
    }

    private async upsertOne(chunk: DocumentChunk): Promise<'inserted' | 'updated' | 'skipped'> {
        const result = await this.execute<UpsertRow>(
            `INSERT INTO document_embeddings (
                user_id, repo_full_name, file_path, heading,
                content, file_type, tags, metadata,
                chunk_index, total_chunks, content_hash,
                embedding, last_synced_at
            ) VALUES (
                $1, $2, $3, $4,
                $5, $6, $7::text[], $8::jsonb,
                $9, $10, $11,
                $12::vector, NOW()
            )
            ON CONFLICT (user_id, repo_full_name, file_path, chunk_index)
            DO UPDATE SET
                heading        = EXCLUDED.heading,
                content        = EXCLUDED.content,
                file_type      = EXCLUDED.file_type,
                tags           = EXCLUDED.tags,
                metadata       = EXCLUDED.metadata,
                total_chunks   = EXCLUDED.total_chunks,
                content_hash   = EXCLUDED.content_hash,
                embedding      = EXCLUDED.embedding,
                last_synced_at = NOW()
            WHERE document_embeddings.content_hash <> EXCLUDED.content_hash
            RETURNING (xmax = 0) AS was_inserted`,
            [
                chunk.userId,
                chunk.repoFullName,
                chunk.filePath,
                chunk.heading ?? null,
                chunk.content,
                chunk.fileType ?? null,
                toPostgresArray(chunk.tags ?? []),
                JSON.stringify(chunk.metadata ?? {}),
                chunk.chunkIndex,
                chunk.totalChunks,
                chunk.contentHash,
                `[${chunk.embedding.join(',')}]`,
            ],
        );

        // No rows from RETURNING → conflict resolved but DO UPDATE WHERE was false
        // (content_hash unchanged) — intentionally not written
        if (result.rows.length === 0) return 'skipped';

        return result.rows[0].was_inserted ? 'inserted' : 'updated';
    }

    // =========================================================================
    // IVectorStore.querySimilar
    // =========================================================================

    async querySimilar(params: QueryParams): Promise<SimilarityResult[]> {
        if (params.useHybrid && params.queryText) {
            return this.queryHybrid(params);
        }
        return this.queryVector(params);
    }

    /** Pure HNSW cosine-similarity search. */
    private async queryVector(params: QueryParams): Promise<SimilarityResult[]> {
        const { userId, repoFullName, queryEmbedding, limit = 10, efSearch = 40 } = params;

        const result = await this.execute<SimilarityRow>(
            `WITH _ AS (
                SELECT set_config('hnsw.ef_search', $1, true)
            )
            SELECT
                d.id,
                d.repo_full_name,
                d.file_path,
                d.heading,
                d.content,
                d.chunk_index,
                d.tags,
                1 - (d.embedding <=> $3::vector) AS similarity
            FROM document_embeddings d, _
            WHERE d.user_id = $2
              AND ($4::text IS NULL OR d.repo_full_name = $4)
            ORDER BY d.embedding <=> $3::vector
            LIMIT $5`,
            [
                String(efSearch),
                userId,
                `[${queryEmbedding.join(',')}]`,
                repoFullName ?? null,
                limit,
            ],
        );

        return result.rows.map(row => this.mapSimilarityRow(row));
    }

    /**
     * Hybrid retrieval: HNSW vector search + BM25 full-text search merged via
     * Reciprocal Rank Fusion (k=60). Each branch contributes at most `limit`
     * candidates; the union is scored and the top `limit` results returned.
     */
    private async queryHybrid(params: QueryParams): Promise<SimilarityResult[]> {
        const { userId, repoFullName, queryEmbedding, queryText, limit = 10, efSearch = 40 } = params;

        const result = await this.execute<SimilarityRow>(
            `WITH set_ef AS (
                SELECT set_config('hnsw.ef_search', $1, true)
            ),
            vector_ranked AS (
                SELECT
                    d.id,
                    ROW_NUMBER() OVER (ORDER BY d.embedding <=> $3::vector) AS vrank
                FROM document_embeddings d, set_ef
                WHERE d.user_id = $2
                  AND ($4::text IS NULL OR d.repo_full_name = $4)
                ORDER BY d.embedding <=> $3::vector
                LIMIT $5
            ),
            text_ranked AS (
                SELECT
                    d.id,
                    ROW_NUMBER() OVER (
                        ORDER BY ts_rank(d.content_tsv, plainto_tsquery('english', $6)) DESC
                    ) AS trank
                FROM document_embeddings d
                WHERE d.user_id = $2
                  AND ($4::text IS NULL OR d.repo_full_name = $4)
                  AND d.content_tsv @@ plainto_tsquery('english', $6)
                ORDER BY ts_rank(d.content_tsv, plainto_tsquery('english', $6)) DESC
                LIMIT $5
            ),
            rrf AS (
                SELECT
                    COALESCE(v.id, t.id) AS id,
                    COALESCE(1.0 / (60 + v.vrank), 0.0)
                        + COALESCE(1.0 / (60 + t.trank), 0.0) AS rrf_score
                FROM vector_ranked v
                FULL OUTER JOIN text_ranked t ON v.id = t.id
            )
            SELECT
                d.id,
                d.repo_full_name,
                d.file_path,
                d.heading,
                d.content,
                d.chunk_index,
                d.tags,
                r.rrf_score AS similarity
            FROM rrf r
            JOIN document_embeddings d ON d.id = r.id
            ORDER BY r.rrf_score DESC
            LIMIT $5`,
            [
                String(efSearch),
                userId,
                `[${queryEmbedding.join(',')}]`,
                repoFullName ?? null,
                limit,
                queryText,
            ],
        );

        return result.rows.map(row => this.mapSimilarityRow(row));
    }

    private mapSimilarityRow(row: SimilarityRow): SimilarityResult {
        return {
            id:           row.id,
            repoFullName: row.repo_full_name,
            filePath:     row.file_path,
            heading:      row.heading,
            content:      row.content,
            chunkIndex:   row.chunk_index,
            tags:         row.tags ?? [],
            similarity:   row.similarity,
        };
    }

    // =========================================================================
    // IVectorStore.checkContentHashes
    // =========================================================================

    async checkContentHashes(
        userId: string,
        repoFullName: string,
        candidates: ChunkIdentity[],
    ): Promise<HashCheckResult> {
        if (candidates.length === 0) {
            return { missing: [], stale: [], unchanged: [] };
        }

        // Single round-trip: inline VALUES table LEFT JOINed against the DB.
        // Positional params: $1=userId, $2=repoFullName,
        // then per candidate i (0-indexed): $3+3i=filePath, $4+3i=chunkIndex, $5+3i=contentHash
        const valuesList = candidates
            .map((_, i) => `($${3 + i * 3}, $${4 + i * 3}::integer, $${5 + i * 3})`)
            .join(', ');

        const values: unknown[] = [userId, repoFullName];
        for (const c of candidates) {
            values.push(c.filePath, c.chunkIndex, c.contentHash);
        }

        const result = await this.execute<HashCheckRow>(
            `SELECT
                c.file_path,
                c.chunk_index::integer,
                c.content_hash     AS candidate_hash,
                d.content_hash     AS stored_hash
            FROM (VALUES ${valuesList}) AS c(file_path, chunk_index, content_hash)
            LEFT JOIN document_embeddings d
              ON  d.user_id        = $1
              AND d.repo_full_name = $2
              AND d.file_path      = c.file_path
              AND d.chunk_index    = c.chunk_index::integer`,
            values,
        );

        const missing: ChunkIdentity[]   = [];
        const stale: ChunkIdentity[]     = [];
        const unchanged: ChunkIdentity[] = [];

        for (const row of result.rows) {
            const identity: ChunkIdentity = {
                filePath:    row.file_path,
                chunkIndex:  row.chunk_index,
                contentHash: row.candidate_hash,
            };

            if (row.stored_hash === null) missing.push(identity);
            else if (row.stored_hash !== row.candidate_hash) stale.push(identity);
            else unchanged.push(identity);
        }

        return { missing, stale, unchanged };
    }

    // =========================================================================
    // IVectorStore.deleteChunksByRepo
    // =========================================================================

    async deleteChunksByRepo(userId: string, repoFullName: string): Promise<number> {
        const result = await this.execute(
            `DELETE FROM document_embeddings
             WHERE user_id = $1 AND repo_full_name = $2`,
            [userId, repoFullName],
        );

        return result.rowCount ?? 0;
    }

    // =========================================================================
    // IVectorStore.pruneDeletedFiles
    // =========================================================================

    async pruneDeletedFiles(
        userId: string,
        repoFullName: string,
        currentFilePaths: string[],
    ): Promise<number> {
        if (currentFilePaths.length === 0) {
            // No files remain — delete the entire repo's chunks
            return this.deleteChunksByRepo(userId, repoFullName);
        }

        // Build $3, $4, ... placeholders for the IN list
        const placeholders = currentFilePaths
            .map((_, i) => `$${3 + i}`)
            .join(', ');

        const result = await this.execute(
            `DELETE FROM document_embeddings
             WHERE user_id        = $1
               AND repo_full_name = $2
               AND file_path NOT IN (${placeholders})`,
            [userId, repoFullName, ...currentFilePaths],
        );

        return result.rowCount ?? 0;
    }

    // =========================================================================
    // Private — pg pool wrapper
    // =========================================================================

    private async execute<T extends object>(
        sql: string,
        values: unknown[] = [],
    ): Promise<QueryResult<T>> {
        return this.pool.query<T>(sql, values);
    }
}
