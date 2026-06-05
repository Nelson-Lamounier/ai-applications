/** @format */
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Pool } from 'pg';

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
 * Upload the canonical PDF to S3 (deterministic key → idempotent on retry) and
 * persist the key + ATS check to the resumes row. The UPDATE is keyed on the
 * resume id created by persistTailoredResume, so re-runs overwrite cleanly.
 */
export async function storeAtsArtifacts(a: StoreAtsArtifactsArgs): Promise<string> {
    const key = `resumes/${a.userId}/${a.resumeId}.pdf`;
    await a.s3.send(new PutObjectCommand({
        Bucket: a.bucket, Key: key, Body: a.pdf, ContentType: 'application/pdf',
    }));
    await a.pool.query(
        `UPDATE resumes SET pdf_s3_key = $1, ats_check_json = $2 WHERE id = $3`,
        [key, JSON.stringify(a.check), a.resumeId],
    );
    return key;
}
