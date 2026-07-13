/** @format */
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Pool } from 'pg';

import type { AtsCheckResult } from './ats-check.schema.js';
import { withUserRls } from '../../lib/rls.js';

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

export interface StoreAtsCheckJsonArgs {
    readonly pool:     Pool;
    readonly resumeId: string;
    readonly userId:   string;
    readonly check:    AtsCheckResult;
}

/**
 * Re-store just the ATS check JSON — no PDF re-upload, no `pdf_s3_key`
 * change. Used by run-pipeline.ts (F6) after the attainable fields
 * (`attainableTotal`/`attainableCovered`/`attainablePassed`/`surfacedKeywords`)
 * and the reconciled `passed` bit are merged onto the check, which happens
 * AFTER `storeAtsArtifacts` already persisted the PRE-attainable value
 * alongside the PDF. Without this second write, `resumes.ats_check_json`
 * (the primary read path) never carries `attainablePassed` — only
 * `pipeline_runs.metadata.analysis.atsCheck` does.
 *
 * RLS-scoped + row-count-checked, mirroring {@link storeAtsArtifacts}.
 */
export async function storeAtsCheckJson(a: StoreAtsCheckJsonArgs): Promise<void> {
    await withUserRls(a.pool, a.userId, async (client) => {
        const res = await client.query(
            `UPDATE resumes SET ats_check_json = $1 WHERE id = $2`,
            [JSON.stringify(a.check), a.resumeId],
        );
        if (res.rowCount === 0) {
            throw new Error(
                `storeAtsCheckJson: UPDATE matched 0 rows for resume ${a.resumeId} ` +
                `(not visible under RLS, or id mismatch)`,
            );
        }
    });
}
