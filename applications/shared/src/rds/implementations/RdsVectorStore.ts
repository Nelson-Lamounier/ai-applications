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
    /**
     * Defaults to false (the in-cluster path connects to PgBouncer with
     * client_tls_sslmode=disable). Set to a require-SSL object for the
     * local-over-tunnel path, which hits RDS directly (RDS enforces SSL).
     */
    readonly ssl?: boolean | { rejectUnauthorized: boolean };
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
    /** Raw cosine (1 − cosine_distance). Present in both query modes. */
    cosine: number | null;
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

/**
 * Rows per multi-row upsert. 14 bind params/row keeps a batch well under
 * Postgres' 65535-param cap while bounding the SQL string size (each row carries
 * a 1024-dim vector literal). Tunable; 200 collapses a 2.4k-chunk repo from
 * ~2400 round-trips to ~12.
 */
const UPSERT_BATCH_SIZE = 200;

/**
 * Dedupe chunks by their ON CONFLICT key `(user, repo, file, chunk)`, keeping
 * the LAST occurrence. A single `INSERT … ON CONFLICT DO UPDATE` cannot affect
 * the same key twice; last-wins matches the prior per-row loop semantics.
 */
function dedupeByConflictKey(chunks: DocumentChunk[]): DocumentChunk[] {
    const byKey = new Map<string, DocumentChunk>();
    for (const c of chunks) {
        byKey.set(JSON.stringify([c.userId, c.repoFullName, c.filePath, c.chunkIndex]), c);
    }
    return Array.from(byKey.values());
}

/** Remove NUL (0x00) — Postgres TEXT rejects it ("invalid byte sequence for encoding UTF8: 0x00"). */
function stripNul(value: string): string {
    return value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
}

/**
 * Strip NUL from a chunk's free-text fields (content, heading) before upsert.
 * Only allocates a new object when a null byte is actually present, so the
 * common (clean) case is a cheap pass-through.
 */
function stripNulFields(chunk: DocumentChunk): DocumentChunk {
    const hasNul = chunk.content.includes('\u0000') || chunk.heading?.includes('\u0000') === true;
    if (!hasNul) return chunk;
    return {
        ...chunk,
        content: stripNul(chunk.content),
        heading: chunk.heading == null ? chunk.heading : stripNul(chunk.heading),
    };
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class RdsVectorStore implements IVectorStore {
    private readonly pool: Pool;
    /**
     * Immutable GitHub numeric repo id, dual-written onto every
     * document_embeddings upsert so a rename heals via a metadata update
     * (reconcileRepoName) rather than a re-ingest. Null on legacy/pre-backfill
     * runs — the column is nullable; the ON CONFLICT clause COALESCEs so a NULL
     * run never clobbers a known id.
     */
    private readonly githubRepoId: number | null;

    /**
     * Head commit SHA of the synced content. Stamped into each chunk's
     * `metadata.commit_sha` so a retrieved chunk is provenance-anchored to the
     * exact commit it came from (pairs with `metadata.lineStart`/`lineEnd` for a
     * full file:line@commit citation). Author/time stay joinable from
     * `repo_commits` on this sha — not denormalised. Null when unknown.
     */
    private readonly commitSha: string | null;

    constructor(
        config: RdsClientConfig,
        pool?: Pool,
        githubRepoId: number | null = null,
        commitSha: string | null = null,
    ) {
        this.githubRepoId = githubRepoId;
        this.commitSha = commitSha;
        this.pool = pool ?? new Pool({
            host:               config.host,
            port:               config.port,
            database:           config.database,
            user:               config.user,
            password:           config.password,
            max:                5,
            idleTimeoutMillis:  30_000,
            // PgBouncer runs with client_tls_sslmode=disable — no SSL on the
            // client→PgBouncer leg. PgBouncer handles the PgBouncer→RDS leg.
            // Overridable for the local-over-tunnel path (direct RDS, SSL enforced).
            ssl:                config.ssl ?? false,
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

        // RDS_SSL=require → encrypt the leg (RDS enforces force_ssl). Used ONLY by the
        // local eval, which reaches RDS through a 127.0.0.1 SSM port-forward tunnel:
        // the cert CN is the RDS endpoint, so hostname verification can't pass over the
        // tunnel → rejectUnauthorized:false. This is not a security downgrade — the SSM
        // tunnel (AWS mutual-TLS + IAM) is the MITM boundary; the in-cluster path is
        // unaffected (ssl:false to PgBouncer). Never set RDS_SSL in production.
        const ssl = process.env.RDS_SSL === 'require' ? { rejectUnauthorized: false } : false;
        return new RdsVectorStore({ host, port: parseInt(port, 10), database, user, password, ssl });
    }

    /** Release all pool connections. Call on graceful shutdown if needed. */
    async end(): Promise<void> {
        await this.pool.end();
    }

    /**
     * Serialise a chunk's metadata for the `metadata` jsonb column, stamping the
     * run's `commit_sha` provenance when known. A chunk-level commit_sha (rare)
     * is not overwritten.
     */
    private metadataJson(chunk: DocumentChunk): string {
        const base = chunk.metadata ?? {};
        if (this.commitSha && base['commit_sha'] === undefined) {
            return JSON.stringify({ ...base, commit_sha: this.commitSha });
        }
        return JSON.stringify(base);
    }

    // =========================================================================
    // IVectorStore.upsertBatch
    // =========================================================================

    async upsertBatch(chunks: DocumentChunk[]): Promise<UpsertBatchResult> {
        if (chunks.length === 0) {
            return { inserted: 0, updated: 0, skipped: 0, errors: 0 };
        }

        // Strip NUL (0x00) from the free-text fields: Postgres TEXT cannot store
        // it ("invalid byte sequence for encoding UTF8: 0x00"), and one chunk
        // from a file with an embedded null byte would otherwise fail the whole
        // batch, then drop on the per-row retry.
        const cleaned = chunks.map((chunk) => stripNulFields(chunk));

        // A single multi-row INSERT cannot touch the same ON CONFLICT key twice,
        // so dedupe by (user, repo, file, chunk) keeping the last occurrence —
        // matching the old per-row loop where a later upsert overwrote earlier.
        const deduped = dedupeByConflictKey(cleaned);

        const totals = { inserted: 0, updated: 0, skipped: 0, errors: 0 };

        for (let i = 0; i < deduped.length; i += UPSERT_BATCH_SIZE) {
            const batch = deduped.slice(i, i + UPSERT_BATCH_SIZE);
            try {
                const r = await this.upsertMany(batch);
                totals.inserted += r.inserted;
                totals.updated  += r.updated;
                totals.skipped  += r.skipped;
            } catch (err) {
                // Fall back to per-row so one malformed chunk doesn't lose the
                // whole batch (preserves the original error tolerance).
                console.error(
                    `[RdsVectorStore.upsertBatch] batch of ${batch.length} failed; ` +
                    `falling back to per-row:`,
                    err,
                );
                const r = await this.upsertRowsIndividually(batch);
                totals.inserted += r.inserted;
                totals.updated  += r.updated;
                totals.skipped  += r.skipped;
                totals.errors   += r.errors;
            }
        }

        return totals;
    }

    /** Per-row upsert fallback — resilient to a single malformed chunk. */
    private async upsertRowsIndividually(chunks: DocumentChunk[]): Promise<UpsertBatchResult> {
        const totals = { inserted: 0, updated: 0, skipped: 0, errors: 0 };
        for (const chunk of chunks) {
            try {
                const outcome = await this.upsertOne(chunk);
                if (outcome === 'inserted') totals.inserted++;
                else if (outcome === 'updated') totals.updated++;
                else totals.skipped++;
            } catch (rowErr) {
                console.error(
                    `[RdsVectorStore.upsertBatch] error on ` +
                    `${chunk.repoFullName}:${chunk.filePath}#${chunk.chunkIndex}:`,
                    rowErr,
                );
                totals.errors++;
            }
        }
        return totals;
    }

    /**
     * One multi-row INSERT … ON CONFLICT DO UPDATE for a deduped batch. Returns
     * inserted/updated counts from RETURNING `(xmax = 0)`; rows whose content
     * hash was unchanged are filtered by the DO UPDATE WHERE clause and so are
     * absent from RETURNING — `skipped = batch − returned`.
     */
    private async upsertMany(
        chunks: DocumentChunk[],
    ): Promise<{ inserted: number; updated: number; skipped: number }> {
        const COLS = 15;
        const tuples: string[] = [];
        const values: unknown[] = [];

        chunks.forEach((chunk, i) => {
            const b = i * COLS;
            tuples.push(
                `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},` +
                `$${b + 7}::text[],$${b + 8}::jsonb,$${b + 9}::text[],$${b + 10}::text[],` +
                `$${b + 11},$${b + 12},$${b + 13},$${b + 14}::vector,$${b + 15},NOW())`,
            );
            values.push(
                chunk.userId,
                chunk.repoFullName,
                chunk.filePath,
                chunk.heading ?? null,
                chunk.content,
                chunk.fileType ?? null,
                toPostgresArray(chunk.tags ?? []),
                this.metadataJson(chunk),
                toPostgresArray(chunk.skills ?? []),
                toPostgresArray(chunk.technologies ?? []),
                chunk.chunkIndex,
                chunk.totalChunks,
                chunk.contentHash,
                `[${chunk.embedding.join(',')}]`,
                this.githubRepoId,
            );
        });

        const result = await this.execute<UpsertRow>(
            `INSERT INTO document_embeddings (
                user_id, repo_full_name, file_path, heading,
                content, file_type, tags, metadata,
                skills, technologies,
                chunk_index, total_chunks, content_hash,
                embedding, github_repo_id, last_synced_at
            ) VALUES ${tuples.join(',')}
            ON CONFLICT (user_id, repo_full_name, file_path, chunk_index)
            DO UPDATE SET
                heading        = EXCLUDED.heading,
                content        = EXCLUDED.content,
                file_type      = EXCLUDED.file_type,
                tags           = EXCLUDED.tags,
                metadata       = EXCLUDED.metadata,
                skills         = EXCLUDED.skills,
                technologies   = EXCLUDED.technologies,
                total_chunks   = EXCLUDED.total_chunks,
                content_hash   = EXCLUDED.content_hash,
                embedding      = EXCLUDED.embedding,
                github_repo_id = COALESCE(EXCLUDED.github_repo_id, document_embeddings.github_repo_id),
                last_synced_at = NOW()
            WHERE document_embeddings.content_hash <> EXCLUDED.content_hash
            RETURNING (xmax = 0) AS was_inserted`,
            values,
        );

        let inserted = 0;
        let updated = 0;
        for (const row of result.rows) {
            if (row.was_inserted) inserted++;
            else updated++;
        }
        return { inserted, updated, skipped: chunks.length - result.rows.length };
    }

    private async upsertOne(chunk: DocumentChunk): Promise<'inserted' | 'updated' | 'skipped'> {
        const result = await this.execute<UpsertRow>(
            `INSERT INTO document_embeddings (
                user_id, repo_full_name, file_path, heading,
                content, file_type, tags, metadata,
                skills, technologies,
                chunk_index, total_chunks, content_hash,
                embedding, github_repo_id, last_synced_at
            ) VALUES (
                $1, $2, $3, $4,
                $5, $6, $7::text[], $8::jsonb,
                $9::text[], $10::text[],
                $11, $12, $13,
                $14::vector, $15, NOW()
            )
            ON CONFLICT (user_id, repo_full_name, file_path, chunk_index)
            DO UPDATE SET
                heading        = EXCLUDED.heading,
                content        = EXCLUDED.content,
                file_type      = EXCLUDED.file_type,
                tags           = EXCLUDED.tags,
                metadata       = EXCLUDED.metadata,
                skills         = EXCLUDED.skills,
                technologies   = EXCLUDED.technologies,
                total_chunks   = EXCLUDED.total_chunks,
                content_hash   = EXCLUDED.content_hash,
                embedding      = EXCLUDED.embedding,
                github_repo_id = COALESCE(EXCLUDED.github_repo_id, document_embeddings.github_repo_id),
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
                this.metadataJson(chunk),
                toPostgresArray(chunk.skills ?? []),
                toPostgresArray(chunk.technologies ?? []),
                chunk.chunkIndex,
                chunk.totalChunks,
                chunk.contentHash,
                `[${chunk.embedding.join(',')}]`,
                this.githubRepoId,
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
        // Filter-then-rank: when a structured pre-filter is present it takes
        // precedence (hard authorship/junk gates + soft tech/skill widener over
        // the metadata stamp), routed through the vector path. Absent ⇒ today's
        // behaviour (hybrid when requested, else pure vector). Fail-open.
        if (params.prefilter) {
            return this.queryVectorFiltered(params);
        }
        if (params.useHybrid && params.queryText) {
            return this.queryHybrid(params);
        }
        return this.queryVector(params);
    }

    /**
     * Filter-then-rank vector search. Pass 1 applies the HARD gates (no fork, no
     * noise/tutorial repo) + the SOFT tech/skill widener; if fewer than `minResults`
     * survive, pass 2 tops up from the hard-gated-only set (soft filter relaxed), so
     * the tech/skill filter can never collapse recall. Hard gates always hold.
     */
    private async queryVectorFiltered(params: QueryParams): Promise<SimilarityResult[]> {
        const { limit = 10, prefilter } = params;
        const minResults = prefilter?.minResults ?? limit;
        const pass1 = await this.runFilteredVector(params, true, []);
        if (pass1.length >= minResults) return pass1;
        const excludeIds = pass1.map((r) => r.id);
        const topUp = await this.runFilteredVector({ ...params, limit: limit - pass1.length }, false, excludeIds);
        return [...pass1, ...topUp];
    }

    /** One filtered vector pass. `applySoft` toggles the tech/skill widener; `excludeIds` skips already-returned chunks. */
    private async runFilteredVector(params: QueryParams, applySoft: boolean, excludeIds: string[]): Promise<SimilarityResult[]> {
        const { userId, repoFullName, queryEmbedding, limit = 10, efSearch = 40, prefilter } = params;
        const skills = prefilter?.skills ?? [];
        const tech = prefilter?.tech ?? [];
        const result = await this.execute<SimilarityRow>(
            `WITH _ AS (SELECT set_config('hnsw.ef_search', $1, true))
             SELECT d.id, d.repo_full_name, d.file_path, d.heading, d.content, d.chunk_index, d.tags,
                    1 - (d.embedding <=> $3::vector) AS similarity,
                    1 - (d.embedding <=> $3::vector) AS cosine
               FROM document_embeddings d, _
              WHERE d.user_id = $2
                AND ($4::text IS NULL OR d.repo_full_name = $4)
                -- HARD gates (verified authorship): never retrieve fork, junk, or
                -- not-the-user's-work code as authored evidence. COALESCE defaults so
                -- unstamped chunks pass (fail-open until the repo is re-synced).
                AND COALESCE((d.metadata->>'is_fork')::bool, false) = false
                AND COALESCE((d.metadata->>'authored')::bool, true) = true
                AND COALESCE(d.metadata->>'repo_classification', 'project') NOT IN ('noise', 'tutorial')
                -- SOFT tech/skill widener (transfer-aware), applied by chunk TYPE:
                --   • PROSE (docs/README) is NEVER tech-gated — it is the cosine "evidence"
                --     lane; gating it by repo tech wrongly drops cross-domain prose (e.g. a
                --     TS/React app's docs for a Python JD).
                --   • CODE/CONFIG with file-grained tech evidence (metadata.file_tech_stack)
                --     must overlap the JD tech — a monitoring YAML stamped {alertmanager} is
                --     excluded from a Python/LLM JD.
                --   • CONFIG WITHOUT file evidence is excluded: it must not free-ride its
                --     repo's stack (the old repo_tech_stack fallback admitted any YAML in a
                --     repo that used a JD tech anywhere). Code/other without evidence passes
                --     to cosine. Chunk skills[] overlap always admits.
                AND ($6::bool = false OR cardinality($7::text[]) = 0
                     OR d.skills && $7::text[]
                     OR (d.metadata ? 'file_tech_stack' AND d.metadata->'file_tech_stack' ?| $7::text[])
                     OR (NOT (d.metadata ? 'file_tech_stack')
                         AND d.file_path !~* '\\.(ya?ml|json|toml|lock|cfg|ini|env|tf|tfvars)$'))
                AND ($8::uuid[] IS NULL OR d.id <> ALL($8))
              ORDER BY d.embedding <=> $3::vector
              LIMIT $5`,
            [
                String(efSearch),
                userId,
                `[${queryEmbedding.join(',')}]`,
                repoFullName ?? null,
                limit,
                applySoft,
                [...new Set([...skills, ...tech])],
                excludeIds.length > 0 ? excludeIds : null,
            ],
        );
        return result.rows.map((row) => this.mapSimilarityRow(row));
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
                1 - (d.embedding <=> $3::vector) AS similarity,
                1 - (d.embedding <=> $3::vector) AS cosine
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
                r.rrf_score AS similarity,
                1 - (d.embedding <=> $3::vector) AS cosine
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
            similarity:   Number(row.similarity),
            cosine:       Number(row.cosine ?? row.similarity),
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
