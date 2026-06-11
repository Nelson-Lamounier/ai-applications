/** @format */
import type { S3Client } from '@aws-sdk/client-s3';
import type { StructuredResumeData, StrategistResearchResult } from '@bedrock/shared';
import type { Pool } from 'pg';

import type { AtsCheckResult } from './ats-check.schema.js';
import { buildAtsCheck } from './checks.js';
import { collectGroundedTerms, collectJdMustHaves } from './jd-keywords.js';
import { parsePdfBack } from './parse-back.js';
import { storeAtsArtifacts } from './store-ats-artifacts.js';
import { withUserRls } from '../lib/rls.js';
import { renderResumePdf } from '../render/render-resume-pdf.js';

/** Minimal structured logger surface (pino-compatible). */
export interface AtsLogger {
    info(obj: object, msg: string): void;
    warn(obj: object, msg: string): void;
}

export interface RunAtsCheckArgs {
    readonly s3:       S3Client;
    readonly pool:     Pool;
    readonly bucket:   string;
    readonly resumeId: string;
    readonly userId:   string;
    readonly resume:   StructuredResumeData;
    readonly research: StrategistResearchResult;
    readonly log:      AtsLogger;
    readonly correlationId: string;
    /** Reports the terminal ATS status for metrics (e.g. `ats_passed`). */
    readonly onOutcome: (status: AtsCheckResult['status'] | 'error') => void;
}

const UNVERIFIED: AtsCheckResult = {
    machineReadable: false, standardSectionsDetected: [],
    contactDetected: { name: '', email: '' }, parseBreakers: [],
    jdKeywordCoverage: [], status: 'unverified', passed: false,
    issues: ['ATS render or parse-back failed.'],
};

/**
 * Render the AI-authored resume to a text-selectable PDF, prove it parses, and
 * store the canonical PDF + check. Fail-open for the pipeline (never throws);
 * fail-closed for the claim (a render/parse error is recorded as 'unverified',
 * never 'passed').
 */
export async function renderCheckAndStoreAts(a: RunAtsCheckArgs): Promise<AtsCheckResult> {
    try {
        const pdf = await renderResumePdf(a.resume);
        const { text, sections } = await parsePdfBack(pdf);
        const check = buildAtsCheck({
            text, sections,
            profile: { name: a.resume.profile.name, email: a.resume.profile.email },
            jdMustHaves:   collectJdMustHaves(a.research),
            groundedTerms: collectGroundedTerms(a.research),
        });
        if (a.bucket) {
            await storeAtsArtifacts({
                s3: a.s3, pool: a.pool, bucket: a.bucket,
                resumeId: a.resumeId, userId: a.userId, pdf, check,
            });
        }
        a.log.info(
            { correlationId: a.correlationId, resumeId: a.resumeId, atsStatus: check.status, atsIssues: check.issues.length },
            'ATS check complete',
        );
        a.onOutcome(check.status);
        return check;
    } catch (e) {
        a.log.warn(
            { correlationId: a.correlationId, resumeId: a.resumeId, error: (e as Error).message },
            'ATS render/check failed — recording unverified',
        );
        // RLS-scoped write (same context requirement as storeAtsArtifacts), so the
        // 'unverified' claim actually persists instead of being silently dropped.
        await withUserRls(a.pool, a.userId, (client) =>
            client.query(`UPDATE resumes SET ats_check_json = $1 WHERE id = $2`, [JSON.stringify(UNVERIFIED), a.resumeId]),
        ).catch(() => undefined);
        a.onOutcome('error');
        return UNVERIFIED;
    }
}
