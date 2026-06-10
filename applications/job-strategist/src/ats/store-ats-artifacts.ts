/** @format */
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Pool, PoolClient } from 'pg';

import type { AtsCheckResult } from './ats-check.schema.js';

export interface StoreAtsArtifactsArgs {
    readonly s3:       S3Client;
    readonly pool:     Pool;
    readonly bucket:   string;
    readonly resumeId: string;
    readonly userId:   string;
    readonly pdf:      Buffer;
    readonly check:    AtsCheckResult;
}

/**
 * Run a write against an RLS-protected table inside a transaction that sets the
 * row-isolation context (`app.current_user_id`).
 *
 * `resumes` has RLS policy `resumes_isolation`
 * (`user_id = current_setting('app.current_user_id', true)::uuid`). The pipeline
 * connects as a non-owner role, so the policy is enforced. pgbouncer runs in
 * transaction-pooling mode, which drops any connection-level `SET` between
 * transactions — so the context MUST be set with `is_local = true` in the SAME
 * transaction as the write. Without it the row is invisible to the policy and the
 * write silently affects 0 rows (no error). Mirrors system-tour-persistence /
 * dsa-evidence.
 */
export async function withUserRls<T>(
    pool: Pool,
    userId: string,
    fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Upload the canonical PDF to S3 (deterministic key → idempotent on retry) and
 * persist the key + ATS check to the resumes row.
 *
 * The UPDATE runs inside the user's RLS context (see {@link withUserRls}) and
 * asserts it matched the row. A 0-row write means the resume is not visible
 * (RLS / id mismatch) and MUST NOT pass silently — that was the bug that left
 * `ats_check_json` NULL even though the pipeline logged "ATS check complete".
 */
export async function storeAtsArtifacts(a: StoreAtsArtifactsArgs): Promise<string> {
    const key = `resumes/${a.userId}/${a.resumeId}.pdf`;
    await a.s3.send(new PutObjectCommand({
        Bucket: a.bucket, Key: key, Body: a.pdf, ContentType: 'application/pdf',
    }));
    await withUserRls(a.pool, a.userId, async (client) => {
        const res = await client.query(
            `UPDATE resumes SET pdf_s3_key = $1, ats_check_json = $2 WHERE id = $3`,
            [key, JSON.stringify(a.check), a.resumeId],
        );
        if (res.rowCount === 0) {
            throw new Error(
                `storeAtsArtifacts: UPDATE matched 0 rows for resume ${a.resumeId} ` +
                `(not visible under RLS, or id mismatch)`,
            );
        }
    });
    return key;
}
