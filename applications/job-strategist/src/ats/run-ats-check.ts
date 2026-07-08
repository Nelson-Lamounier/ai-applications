/** @format */
import type { S3Client } from '@aws-sdk/client-s3';
import type { StructuredResumeData, StrategistResearchResult } from '@bedrock/shared';
import type { Pool } from 'pg';

import type { AtsCheckResult } from './ats-check.schema.js';
import type { CoverageRow } from './checks.js';
import { buildAtsCheck } from './checks.js';
import { collectJdMustHaves, buildGroundedChecker } from './jd-keywords.js';
import { matchTerm, type Embedder } from './keyword-match.js';
import { parsePdfBack } from './parse-back.js';
import { storeAtsArtifacts } from './store-ats-artifacts.js';
import { withUserRls } from '../lib/rls.js';
import { renderResumePdf } from '../render/render-resume-pdf.js';
import type { JdExtraction } from '../agents/jd-extractor.js';

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
    /** Structured JD extraction (v2 atomic must-haves). Pass null to fall back to research. */
    readonly jdExtraction?: JdExtraction | null;
    /** Role-family vocabulary groups for ontology-tier matching. */
    readonly familyVocab?: string[][];
    /** Embedder for semantic (Tier 3) matching. Pass null to skip. */
    readonly embedder?: Embedder | null;
    /** Tech transfer/category groups for tech-transfer-tier matching. */
    readonly techGroups?: string[][];
    /** Alias → canonical map (lowercased keys) for tech-transfer-tier matching. */
    readonly techAliasMap?: Map<string, string>;
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
        const { text, sections, pages } = await parsePdfBack(pdf);

        // Must-haves = the single JD signal's technology inventory (atomic, the same list
        // the writer targets). a.research is the assembled brief carrying technologyInventory.
        const mustHaves = collectJdMustHaves(a.research, (dropped) =>
            a.log.warn({ correlationId: a.correlationId, dropped }, 'ATS keyword cap truncated JD inventory'));
        const familyVocab = a.familyVocab ?? [];
        const embedder = a.embedder ?? null;
        const threshold = Number(process.env['ATS_KEYWORD_EMBED_THRESHOLD'] ?? '0.55');
        const techGroups = a.techGroups ?? [];
        const techAliasMap = a.techAliasMap;
        // Transfer-aware grounding: Podman counts as grounded when Docker is
        // evidenced (same transfer family) — direct verified/partial evidence
        // as before, family co-membership as the new second route.
        const isGrounded = buildGroundedChecker(a.research, techGroups, techAliasMap);

        // Embed the resume text once (fail-open: undefined on error).
        const resumeTextLower = text.toLowerCase();
        let resumeVector: number[] | undefined;
        if (embedder) {
            resumeVector = await embedder.embed(text.slice(0, 8000)).catch(() => undefined);
        }

        // Build coverage async — 4-tier matchTerm per term.
        const coverage: CoverageRow[] = [];
        for (const term of mustHaves) {
            const m = await matchTerm(term, resumeTextLower, { familyVocab, embedder, threshold, resumeVector, techGroups: techGroups.length > 0 ? techGroups : undefined, techAliasMap });
            coverage.push({
                term,
                present:  m.present,
                grounded: isGrounded(term),
                tier:     m.tier,
            });
        }

        const check = buildAtsCheck({
            text, sections, pages,
            profile: { name: a.resume.profile.name, email: a.resume.profile.email },
            coverage,
            requiredSkills: a.jdExtraction?.requiredSkills ?? [],
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
