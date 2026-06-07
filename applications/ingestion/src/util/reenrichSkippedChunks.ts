/** @format */
import type { Pool } from 'pg';
import type { IChunkEnricher } from '@bedrock/shared';

/** Filter + bounds for a re-enrich run. */
export interface ReenrichOptions {
    /** Restrict to one user (omit = all users with skipped chunks). */
    readonly userId?: string;
    /** Restrict to one repo (omit = all repos in scope). */
    readonly repoFullName?: string;
    /** Cap chunks processed this run (omit = no cap). */
    readonly limit?: number;
    /** Concurrent enrich calls. Default 10. */
    readonly concurrency?: number;
    /** Progress callback (done, total). */
    readonly onProgress?: (done: number, total: number) => void;
}

export interface ReenrichResult {
    readonly candidates: number;
    readonly enriched: number;
    readonly failed: number;
}

interface SkippedRow {
    id:        string;
    file_path: string;
    heading:   string | null;
    content:   string;
}

/**
 * Re-enrich chunks previously marked `enrichment_status='skipped_quota'` — i.e.
 * chunks that exceeded `MAX_ENRICHMENT_PER_INGESTION` during ingestion and so
 * carry no skills. Enriches `skills` in place via the supplied enricher and
 * flips the status to `'ok'` — NO re-embedding (the vector is untouched).
 *
 * Idempotent: a re-run only sees rows still marked `skipped_quota`, so a chunk
 * whose enrich call failed (e.g. real Bedrock throttling) stays a candidate and
 * is retried next run. Cheap (~$0.001/chunk).
 */
export async function reenrichSkippedChunks(
    pool: Pool,
    enricher: IChunkEnricher,
    opts: ReenrichOptions = {},
): Promise<ReenrichResult> {
    const conditions = [`metadata->>'enrichment_status' = 'skipped_quota'`];
    const params: unknown[] = [];
    if (opts.userId) {
        params.push(opts.userId);
        conditions.push(`user_id = $${params.length}::uuid`);
    }
    if (opts.repoFullName) {
        params.push(opts.repoFullName);
        conditions.push(`repo_full_name = $${params.length}`);
    }
    const limitClause = opts.limit ? `LIMIT ${Math.trunc(opts.limit)}` : '';

    const { rows } = await pool.query<SkippedRow>(
        `SELECT id, file_path, heading, content
           FROM document_embeddings
          WHERE ${conditions.join(' AND ')}
          ORDER BY repo_full_name, file_path, chunk_index
          ${limitClause}`,
        params,
    );

    let enriched = 0;
    let failed = 0;
    let done = 0;

    async function processRow(row: SkippedRow): Promise<void> {
        try {
            const { skills } = await enricher.enrich({
                filePath:    row.file_path,
                heading:     row.heading ?? undefined,
                content:     row.content,
                chunkIndex:  0,
                totalChunks: 1,
            });
            await pool.query(
                `UPDATE document_embeddings
                    SET skills   = $1::text[],
                        metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb),
                                             '{enrichment_status}', '"ok"')
                  WHERE id = $2`,
                [skills, row.id],
            );
            enriched += 1;
        } catch {
            // Leave the row as skipped_quota so the next run retries it.
            failed += 1;
        } finally {
            done += 1;
            opts.onProgress?.(done, rows.length);
        }
    }

    // Concurrency-limited worker pool over a shared cursor.
    let cursor = 0;
    async function worker(): Promise<void> {
        while (cursor < rows.length) {
            const index = cursor;
            cursor += 1;
            await processRow(rows[index]);
        }
    }
    const workers = Math.max(1, Math.min(opts.concurrency ?? 10, rows.length));
    await Promise.all(Array.from({ length: workers }, () => worker()));

    return { candidates: rows.length, enriched, failed };
}
