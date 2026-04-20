/**
 * @format
 * AuroraVectorStore — IVectorStore backed by Aurora Serverless v2 + pgvector
 *
 * All SQL is executed via the RDS Data API (HTTPS) — no VPC Lambda required.
 * Each public method is a single responsibility: one SQL operation per method.
 *
 * Upsert ordering:
 *   Sequential — not parallel. Aurora Serverless v2 (minAcu=0) uses an RDS
 *   Proxy layer for connection slot management. Concurrent requests during a
 *   cold ACU scale-up can queue and timeout. Sequential processing gives
 *   Aurora time to scale before the next request arrives. Introduce parallelism
 *   (concurrency 3–5) only after measuring that Aurora stays warm during a
 *   full repo scan.
 */

import {
    RDSDataClient,
    ExecuteStatementCommand,
    type Field,
    type SqlParameter,
} from '@aws-sdk/client-rds-data';

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

export interface AuroraClientConfig {
    readonly resourceArn: string;
    readonly secretArn: string;
    readonly database: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Convert string[] of kebab-case tags to a PostgreSQL array literal.
 * '{aws,kubernetes,ci-cd}' — sufficient for tags with no commas or spaces.
 */
function toPostgresArray(tags: string[]): string {
    return `{${tags.join(',')}}`;
}

/**
 * Parse a PostgreSQL array literal from the Data API into string[].
 * '{aws,kubernetes,ci-cd}' → ['aws', 'kubernetes', 'ci-cd']
 * '{}' or null/undefined → []
 */
function parsePgArray(raw: string | undefined | null): string[] {
    if (!raw || raw === '{}') return [];
    return raw.slice(1, -1).split(',');
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class AuroraVectorStore implements IVectorStore {
    private readonly client: RDSDataClient;
    private readonly config: AuroraClientConfig;

    constructor(config: AuroraClientConfig) {
        this.config = config;
        this.client = new RDSDataClient({});
    }

    /**
     * Resolve config from Lambda environment variables.
     * Use this factory in Lambda handlers — not in unit tests.
     */
    static fromEnvironment(): AuroraVectorStore {
        const resourceArn = process.env.AURORA_CLUSTER_ARN;
        const secretArn   = process.env.AURORA_SECRET_ARN;
        const database    = process.env.AURORA_DB_NAME;

        if (!resourceArn || !secretArn || !database) {
            throw new Error(
                'AuroraVectorStore: missing environment variables. ' +
                'Required: AURORA_CLUSTER_ARN, AURORA_SECRET_ARN, AURORA_DB_NAME',
            );
        }

        return new AuroraVectorStore({ resourceArn, secretArn, database });
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
                    `[AuroraVectorStore.upsertBatch] error on ` +
                    `${chunk.repoFullName}:${chunk.filePath}#${chunk.chunkIndex}:`,
                    err,
                );
                errors++;
            }
        }

        return { inserted, updated, skipped, errors };
    }

    private async upsertOne(chunk: DocumentChunk): Promise<'inserted' | 'updated' | 'skipped'> {
        const { records } = await this.execute(
            `INSERT INTO document_embeddings (
                user_id, repo_full_name, file_path, heading,
                content, file_type, tags,
                chunk_index, total_chunks, content_hash,
                embedding, last_synced_at
            ) VALUES (
                :userId, :repoFullName, :filePath, :heading,
                :content, :fileType, :tags::text[],
                :chunkIndex, :totalChunks, :contentHash,
                :embedding::vector, NOW()
            )
            ON CONFLICT (user_id, repo_full_name, file_path, chunk_index)
            DO UPDATE SET
                heading        = EXCLUDED.heading,
                content        = EXCLUDED.content,
                file_type      = EXCLUDED.file_type,
                tags           = EXCLUDED.tags,
                total_chunks   = EXCLUDED.total_chunks,
                content_hash   = EXCLUDED.content_hash,
                embedding      = EXCLUDED.embedding,
                last_synced_at = NOW()
            WHERE document_embeddings.content_hash <> EXCLUDED.content_hash
            RETURNING (xmax = 0) AS was_inserted`,
            [
                { name: 'userId',       value: { stringValue: chunk.userId } },
                { name: 'repoFullName', value: { stringValue: chunk.repoFullName } },
                { name: 'filePath',     value: { stringValue: chunk.filePath } },
                { name: 'heading',      value: chunk.heading ? { stringValue: chunk.heading } : { isNull: true } },
                { name: 'content',      value: { stringValue: chunk.content } },
                { name: 'fileType',     value: chunk.fileType ? { stringValue: chunk.fileType } : { isNull: true } },
                { name: 'tags',         value: { stringValue: toPostgresArray(chunk.tags ?? []) } },
                { name: 'chunkIndex',   value: { longValue: chunk.chunkIndex } },
                { name: 'totalChunks',  value: { longValue: chunk.totalChunks } },
                { name: 'contentHash',  value: { stringValue: chunk.contentHash } },
                { name: 'embedding',    value: { stringValue: `[${chunk.embedding.join(',')}]` } },
            ],
        );

        // No rows from RETURNING → conflict resolved but DO UPDATE WHERE was false
        // (content_hash unchanged) — intentionally not written
        if (!records || records.length === 0) return 'skipped';

        return records[0][0].booleanValue ? 'inserted' : 'updated';
    }

    // =========================================================================
    // IVectorStore.querySimilar
    // =========================================================================

    async querySimilar(params: QueryParams): Promise<SimilarityResult[]> {
        const { userId, repoFullName, queryEmbedding, limit = 10, efSearch = 40 } = params;

        const repoFilter = repoFullName ? 'AND d.repo_full_name = :repoFullName' : '';

        const { records } = await this.execute(
            `WITH _ AS (
                SELECT set_config('hnsw.ef_search', :efSearch::text, true)
            )
            SELECT
                d.id,
                d.repo_full_name,
                d.file_path,
                d.heading,
                d.content,
                d.chunk_index,
                d.tags,
                1 - (d.embedding <=> :queryEmbedding::vector) AS similarity
            FROM document_embeddings d, _
            WHERE d.user_id = :userId
              ${repoFilter}
            ORDER BY d.embedding <=> :queryEmbedding::vector
            LIMIT :limit`,
            [
                { name: 'userId',         value: { stringValue: userId } },
                { name: 'queryEmbedding', value: { stringValue: `[${queryEmbedding.join(',')}]` } },
                { name: 'efSearch',       value: { longValue: efSearch } },
                { name: 'limit',          value: { longValue: limit } },
                ...(repoFullName
                    ? [{ name: 'repoFullName', value: { stringValue: repoFullName } }]
                    : []),
            ],
        );

        return (records ?? []).map((row: Field[]) => ({
            id:           row[0].stringValue!,
            repoFullName: row[1].stringValue!,
            filePath:     row[2].stringValue!,
            heading:      row[3].stringValue ?? null,
            content:      row[4].stringValue!,
            chunkIndex:   row[5].longValue!,
            tags:         parsePgArray(row[6].stringValue),
            similarity:   row[7].doubleValue ?? 0,
        }));
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
        // Avoids N separate queries for N candidates.
        const valuesList = candidates
            .map((_, i) => `(:filePath${i}, :chunkIndex${i}::integer, :contentHash${i})`)
            .join(', ');

        const parameters: SqlParameter[] = [
            { name: 'userId',       value: { stringValue: userId } },
            { name: 'repoFullName', value: { stringValue: repoFullName } },
            ...candidates.flatMap((c, i) => [
                { name: `filePath${i}`,    value: { stringValue: c.filePath } },
                { name: `chunkIndex${i}`,  value: { longValue: c.chunkIndex } },
                { name: `contentHash${i}`, value: { stringValue: c.contentHash } },
            ]),
        ];

        const { records } = await this.execute(
            `SELECT
                c.file_path,
                c.chunk_index::integer,
                c.content_hash     AS candidate_hash,
                d.content_hash     AS stored_hash
            FROM (VALUES ${valuesList}) AS c(file_path, chunk_index, content_hash)
            LEFT JOIN document_embeddings d
              ON  d.user_id        = :userId
              AND d.repo_full_name = :repoFullName
              AND d.file_path      = c.file_path
              AND d.chunk_index    = c.chunk_index::integer`,
            parameters,
        );

        const missing: ChunkIdentity[]   = [];
        const stale: ChunkIdentity[]     = [];
        const unchanged: ChunkIdentity[] = [];

        for (const row of records ?? []) {
            const filePath      = (row as Field[])[0].stringValue!;
            const chunkIndex    = (row as Field[])[1].longValue!;
            const candidateHash = (row as Field[])[2].stringValue!;
            const storedHash    = (row as Field[])[3].stringValue ?? null;
            const identity: ChunkIdentity = { filePath, chunkIndex, contentHash: candidateHash };

            if (storedHash === null) missing.push(identity);
            else if (storedHash !== candidateHash) stale.push(identity);
            else unchanged.push(identity);
        }

        return { missing, stale, unchanged };
    }

    // =========================================================================
    // IVectorStore.deleteChunksByRepo
    // =========================================================================

    async deleteChunksByRepo(userId: string, repoFullName: string): Promise<number> {
        const { numberOfRecordsUpdated } = await this.execute(
            `DELETE FROM document_embeddings
             WHERE user_id = :userId AND repo_full_name = :repoFullName`,
            [
                { name: 'userId',       value: { stringValue: userId } },
                { name: 'repoFullName', value: { stringValue: repoFullName } },
            ],
        );

        return numberOfRecordsUpdated ?? 0;
    }

    // =========================================================================
    // Private — Data API wrapper
    // =========================================================================

    private async execute(sql: string, parameters: SqlParameter[] = []) {
        return this.client.send(new ExecuteStatementCommand({
            resourceArn: this.config.resourceArn,
            secretArn:   this.config.secretArn,
            database:    this.config.database,
            sql,
            parameters,
        }));
    }
}
