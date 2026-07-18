/**
 * @format
 * doc-type-backfill — stamp `metadata.docType` on docs-lane chunks embedded
 * before the ChunkerRegistry choke point started stamping it at ingest time
 * (see doc-type-classifier.ts). Re-reads each file's first chunk to classify
 * once per file, then rewrites `docType` on every chunk that file produced.
 *
 * Follows the `document_embeddings` write convention already established by
 * `reenrichSkippedChunks.writeSkills`: the ingestion pool writes this table
 * directly, with no RLS `set_config` step (the pool's role bypasses RLS the
 * same way that precedent does — table-owner/superuser writes, per the
 * migration 003 comment). Per-file UPDATEs for one repo are batched inside a
 * single BEGIN/COMMIT transaction so a mid-repo failure never leaves that
 * repo half-stamped; ROLLBACK + client release happen in all cases.
 *
 * Pure and idempotent: `classifyDocType` is deterministic, so re-running
 * re-stamps the same `docType` values.
 */
import type { Pool, PoolClient } from 'pg';

import { classifyDocType } from './doc-type-classifier.js';

export interface BackfillDocTypesResult {
    readonly repos:     number;
    readonly files:     number;
    readonly byDocType: Record<string, number>;
}

interface DocFileRow {
    file_path: string;
    content:   string;
}

/** How much of a file's content the classifier's content-sniff tier sees. */
const CLASSIFY_CONTENT_CHARS = 2000;

async function loadRepoFullNames(pool: Pool, userId: string, repoFullName?: string): Promise<string[]> {
    if (repoFullName) return [repoFullName];
    const { rows } = await pool.query<{ repo_full_name: string }>(
        `SELECT DISTINCT repo_full_name
           FROM document_embeddings
          WHERE user_id = $1::uuid AND metadata->>'fileClass' = 'docs'`,
        [userId],
    );
    return rows.map((row) => row.repo_full_name);
}

async function loadDocsFiles(pool: Pool, userId: string, repoFullName: string): Promise<DocFileRow[]> {
    const { rows } = await pool.query<DocFileRow>(
        `SELECT file_path, content
           FROM document_embeddings
          WHERE user_id = $1::uuid AND repo_full_name = $2
            AND metadata->>'fileClass' = 'docs' AND chunk_index = 0`,
        [userId, repoFullName],
    );
    return rows;
}

/** Stamp `docType` on every chunk of one file (per-file uniform, per Task 1). */
async function stampFile(
    client: PoolClient, userId: string, repoFullName: string, filePath: string, docType: string,
): Promise<void> {
    await client.query(
        `UPDATE document_embeddings
            SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{docType}', to_jsonb($3::text))
          WHERE user_id = $1::uuid AND repo_full_name = $2 AND file_path = $4
            AND metadata->>'fileClass' = 'docs'`,
        [userId, repoFullName, docType, filePath],
    );
}

/** Classify and stamp every docs-lane file of one repo inside one transaction. */
async function backfillRepo(
    pool: Pool, userId: string, repoFullName: string, byDocType: Record<string, number>,
): Promise<number> {
    const files = await loadDocsFiles(pool, userId, repoFullName);
    if (files.length === 0) return 0;

    const client = await pool.connect();
    try {
        // bulk document_embeddings path: runs as superuser by design (2026-05-16 rls plan D4); not demoted
        await client.query('BEGIN');
        for (const file of files) {
            const docType = classifyDocType(file.file_path, file.content.slice(0, CLASSIFY_CONTENT_CHARS));
            await stampFile(client, userId, repoFullName, file.file_path, docType);
            byDocType[docType] = (byDocType[docType] ?? 0) + 1;
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* best-effort */ });
        throw err;
    } finally {
        client.release();
    }
    return files.length;
}

/**
 * Backfill `metadata.docType` for a user's existing docs-lane chunks (all
 * repos, or a single repo when `repoFullName` is given). Returns the number
 * of repos and files touched plus a per-docType tally for logging.
 */
export async function backfillDocTypes(
    pool: Pool,
    userId: string,
    repoFullName?: string,
): Promise<BackfillDocTypesResult> {
    const repoFullNames = await loadRepoFullNames(pool, userId, repoFullName);
    const byDocType: Record<string, number> = {};

    let files = 0;
    for (const repo of repoFullNames) {
        files += await backfillRepo(pool, userId, repo, byDocType);
    }

    return { repos: repoFullNames.length, files, byDocType };
}
