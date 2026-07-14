/** @format */
// Both mocks default to the REAL implementation (jest.requireActual) — `clearMocks`
// (jest.config.base.cjs) only clears call history between tests, not the
// implementation set here — so the existing full-render tests below are
// unaffected. Individual tests override with mockRejectedValueOnce /
// mockReturnValueOnce to exercise the catch-path / schema-drift paths (F8).
jest.mock('../../../render/render-resume-pdf.js', () => ({
    ...jest.requireActual('../../../render/render-resume-pdf.js'),
    renderResumePdf: jest.fn(jest.requireActual('../../../render/render-resume-pdf.js').renderResumePdf),
}));
jest.mock('../checks.js', () => ({
    ...jest.requireActual('../checks.js'),
    buildAtsCheck: jest.fn(jest.requireActual('../checks.js').buildAtsCheck),
}));

import type { S3Client } from '@aws-sdk/client-s3';
import type { StrategistResearchResult, StructuredResumeData } from '@bedrock/shared';
import type { Pool } from 'pg';

import type { AtsCheckResult } from '../ats-check.schema.js';
import { buildAtsCheck } from '../checks.js';
import type { Embedder } from '../../matching/keyword-match.js';
import { renderResumePdf } from '../../../render/render-resume-pdf.js';
import { renderCheckAndStoreAts, type AtsLogger } from '../run-ats-check.js';

const mockRenderResumePdf = renderResumePdf as jest.Mock;
const mockBuildAtsCheck = buildAtsCheck as jest.Mock;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const RESUME: StructuredResumeData = {
    profile: { name: 'Jane Doe', title: 'Platform Engineer', email: 'jane@example.com', location: 'Berlin' },
    summary: 'Platform engineer.',
    // "root-cause analysis" → after normalization → "root cause analysis" which matches
    // the tokens of the JD phrase "root cause analysis". The resume also contains
    // "critical thinking" to make the full-phrase normalized match work.
    experience: [{ company: 'Acme', title: 'SRE', period: '2022–2026', highlights: ['Ran Kubernetes on AWS. Critical thinking and root-cause analysis of failures.'] }],
    skills: [{ category: 'Infra', skills: ['Kubernetes', 'AWS'] }],
    education: [{ degree: 'BSc CS', institution: 'TU Berlin', period: '2014–2018' }],
    certifications: [], projects: [], keyAchievements: [],
};

// Only the fields collectJdMustHaves/collectGroundedTerms read are needed.
// Must-haves come ONLY from technologyInventory (the single JD signal the writer
// targets), so the normalized-match phrase + the genuine gap live there:
//   methodologies → "Critical thinking and root cause analysis" (normalized match
//     vs the resume's "root-cause analysis")
//   tools         → "ChatGPT" (a genuine gap, tier none with no embedder)
const RESEARCH = {
    hardRequirements: [{ skill: 'Kubernetes', context: '' }],
    technologyInventory: {
        languages: [], frameworks: [], infrastructure: [],
        tools: ['ChatGPT'],
        methodologies: ['Critical thinking and root cause analysis'],
    },
    verifiedMatches: [{ skill: 'Kubernetes', sourceCitation: '', depth: 'deep', recency: '' }],
    partialMatches: [],
} as unknown as StrategistResearchResult;

const silentLog: AtsLogger = { info: () => undefined, warn: () => undefined };

// NOTE: this suite renders a REAL PDF (renderResumePdf → loadReactPdf → @react-pdf/renderer)
// and parses it back, so it is the live coverage for the PDF render path. A standalone
// react-pdf.test.ts smoke test was removed: loading that heavy un-mockable ESM module on
// its own raced jest's worker teardown ("Test environment has been torn down") and flaked
// in CI; here the full render awaits to completion, so the module settles before teardown.
describe('renderCheckAndStoreAts', () => {
    it('renders, passes the check, stores artifacts, and reports the outcome', async () => {
        const put = jest.fn().mockResolvedValue({});
        const s3 = { send: put } as unknown as S3Client;
        const query = jest.fn().mockResolvedValue({ rowCount: 1 });
        const release = jest.fn();
        const connect = jest.fn().mockResolvedValue({ query, release });
        const pool = { connect } as unknown as Pool;
        const outcomes: string[] = [];

        const check = await renderCheckAndStoreAts({
            s3, pool, bucket: 'assets-bucket', resumeId: 'r-1', userId: 'u-1',
            resume: RESUME, research: RESEARCH, log: silentLog, correlationId: 'p-1',
            onOutcome: s => outcomes.push(s),
        });

        expect(check.passed).toBe(true);
        expect(check.status).toBe('passed');
        expect(put).toHaveBeenCalledTimes(1);          // PDF uploaded
        expect(connect).toHaveBeenCalledTimes(1);      // resumes row updated in RLS txn
        expect(query.mock.calls.some((c) => /UPDATE resumes/i.test(c[0] as string))).toBe(true);
        expect(outcomes).toEqual(['passed']);
    });

    it('skips S3 upload when no bucket is configured but still returns the check', async () => {
        const put = jest.fn().mockResolvedValue({});
        const s3 = { send: put } as unknown as S3Client;
        const pool = { query: jest.fn() } as unknown as Pool;

        const check = await renderCheckAndStoreAts({
            s3, pool, bucket: '', resumeId: 'r-1', userId: 'u-1',
            resume: RESUME, research: RESEARCH, log: silentLog, correlationId: 'p-1',
            onOutcome: () => undefined,
        });

        expect(check.machineReadable).toBe(true);
        expect(put).not.toHaveBeenCalled();
    });

    it('matches a normalized phrase and marks a genuine gap as absent (tier none) — null embedder', async () => {
        const put = jest.fn().mockResolvedValue({});
        const s3 = { send: put } as unknown as S3Client;
        const query = jest.fn().mockResolvedValue({ rowCount: 1 });
        const release = jest.fn();
        const connect = jest.fn().mockResolvedValue({ query, release });
        const pool = { connect } as unknown as Pool;

        const check = await renderCheckAndStoreAts({
            s3, pool, bucket: 'assets-bucket', resumeId: 'r-2', userId: 'u-1',
            resume: RESUME, research: RESEARCH, log: silentLog, correlationId: 'p-2',
            onOutcome: () => undefined,
            familyVocab:  [],
            embedder:     null,
        });

        // "Critical thinking and root cause analysis" → resume has "root-cause analysis"
        // After normalization the phrase reduces to tokens that should match.
        const rootCause = check.jdKeywordCoverage.find(
            (c) => c.term === 'Critical thinking and root cause analysis',
        );
        expect(rootCause).toBeDefined();
        // normalized or literal tier — either counts as present
        expect(rootCause?.present).toBe(true);
        expect(rootCause?.tier).not.toBe('none');

        // "ChatGPT" is not in the resume → absent, tier none (no embedder).
        const chatGpt = check.jdKeywordCoverage.find((c) => c.term === 'ChatGPT');
        expect(chatGpt).toBeDefined();
        expect(chatGpt?.present).toBe(false);
        expect(chatGpt?.tier).toBe('none');
    });
});

describe('renderCheckAndStoreAts — recovery-UPDATE visibility on the catch path (F8)', () => {
    it('warns (does not silently swallow) when the recovery UPDATE matches 0 rows', async () => {
        mockRenderResumePdf.mockRejectedValueOnce(new Error('render boom'));
        const s3 = { send: jest.fn() } as unknown as S3Client;
        const query = jest.fn().mockResolvedValue({ rowCount: 0 });
        const release = jest.fn();
        const connect = jest.fn().mockResolvedValue({ query, release });
        const pool = { connect } as unknown as Pool;
        const warn = jest.fn();
        const log: AtsLogger = { info: () => undefined, warn };
        const outcomes: string[] = [];

        const check = await renderCheckAndStoreAts({
            s3, pool, bucket: 'assets-bucket', resumeId: 'r-3', userId: 'u-1',
            resume: RESUME, research: RESEARCH, log, correlationId: 'p-3',
            onOutcome: (s) => outcomes.push(s),
        });

        expect(check.status).toBe('unverified');
        expect(outcomes).toEqual(['error']);
        expect(warn.mock.calls.some(([, msg]) => /recovery UPDATE matched 0 rows/i.test(msg as string))).toBe(true);
    });

    it('stays fail-open (never throws) when the recovery UPDATE itself errors', async () => {
        mockRenderResumePdf.mockRejectedValueOnce(new Error('render boom'));
        const s3 = { send: jest.fn() } as unknown as S3Client;
        const connect = jest.fn().mockRejectedValue(new Error('pool exhausted'));
        const pool = { connect } as unknown as Pool;
        const warn = jest.fn();
        const log: AtsLogger = { info: () => undefined, warn };

        await expect(renderCheckAndStoreAts({
            s3, pool, bucket: 'assets-bucket', resumeId: 'r-4', userId: 'u-1',
            resume: RESUME, research: RESEARCH, log, correlationId: 'p-4',
            onOutcome: () => undefined,
        })).resolves.toMatchObject({ status: 'unverified' });

        expect(warn.mock.calls.some(([, msg]) => /recovery UPDATE failed/i.test(msg as string))).toBe(true);
    });
});

describe('renderCheckAndStoreAts — schema safeParse at the store boundary (F8 minor)', () => {
    const INVALID_CHECK = {
        machineReadable: true,
        standardSectionsDetected: ['Experience'],
        contactDetected: { name: 'Jane Doe', email: 'jane@example.com' },
        parseBreakers: [],
        jdKeywordCoverage: [],
        // Not a member of the status enum — this is the drift the schema guard exists to catch.
        status: 'weird-status',
        passed: true,
        issues: [],
    } as unknown as AtsCheckResult;

    it('logs a schema-validation warning and still proceeds (fail-open) on a malformed check shape', async () => {
        mockBuildAtsCheck.mockReturnValueOnce(INVALID_CHECK);
        const put = jest.fn().mockResolvedValue({});
        const s3 = { send: put } as unknown as S3Client;
        const query = jest.fn().mockResolvedValue({ rowCount: 1 });
        const release = jest.fn();
        const connect = jest.fn().mockResolvedValue({ query, release });
        const pool = { connect } as unknown as Pool;
        const warn = jest.fn();
        const log: AtsLogger = { info: () => undefined, warn };
        const outcomes: string[] = [];

        const check = await renderCheckAndStoreAts({
            s3, pool, bucket: 'assets-bucket', resumeId: 'r-5', userId: 'u-1',
            resume: RESUME, research: RESEARCH, log, correlationId: 'p-5',
            onOutcome: (s) => outcomes.push(s),
        });

        // Fail-open: the malformed object is still returned, stored, and reported — not thrown.
        expect(check).toEqual(INVALID_CHECK);
        expect(put).toHaveBeenCalledTimes(1);
        expect(outcomes).toEqual(['weird-status']);
        expect(warn.mock.calls.some(([obj, msg]) =>
            /schema validation/i.test(msg as string) && Array.isArray((obj as { issues?: unknown[] }).issues),
        )).toBe(true);
    });
});

describe('renderCheckAndStoreAts — parallelised per-term coverage tier', () => {
    it('preserves coverage order across mustHaves even when embedding calls settle out of order', async () => {
        // Three genuine gaps, one per technologyInventory category, so
        // collectJdMustHaves orders them tools -> languages -> methodologies:
        // GapAlpha, GapBeta, GapGamma. None appear in RESUME, so all three fall
        // through tiers 1-3 to the embedding tier (Tier 4). Each resolves with a
        // DIFFERENT delay, deliberately reversed relative to array order, so a
        // naive concurrent implementation without Promise.all's order guarantee
        // would scramble the result — Promise.all must not.
        const gapResearch = {
            hardRequirements: [],
            technologyInventory: {
                languages: ['GapBeta'], frameworks: [], infrastructure: [],
                tools: ['GapAlpha'], methodologies: ['GapGamma'],
            },
            verifiedMatches: [], partialMatches: [],
        } as unknown as StrategistResearchResult;

        const embedder: Embedder = {
            embed: async (text: string): Promise<number[]> => {
                if (text === 'GapAlpha') { await sleep(30); return [0, 1]; }
                if (text === 'GapBeta')  { await sleep(15); return [0, 1]; }
                if (text === 'GapGamma') { await sleep(0);  return [0, 1]; }
                // Resume-text embedding (computed once, before the per-term fan-out).
                return [1, 0];
            },
        };

        const put = jest.fn().mockResolvedValue({});
        const s3 = { send: put } as unknown as S3Client;
        const query = jest.fn().mockResolvedValue({ rowCount: 1 });
        const release = jest.fn();
        const connect = jest.fn().mockResolvedValue({ query, release });
        const pool = { connect } as unknown as Pool;

        const check = await renderCheckAndStoreAts({
            s3, pool, bucket: 'assets-bucket', resumeId: 'r-6', userId: 'u-1',
            resume: RESUME, research: gapResearch, log: silentLog, correlationId: 'p-6',
            onOutcome: () => undefined,
            familyVocab: [], embedder,
        });

        expect(check.jdKeywordCoverage.map((c) => c.term)).toEqual(['GapAlpha', 'GapBeta', 'GapGamma']);
        // Orthogonal vectors (cosine 0) never cross the threshold — all three are
        // genuine gaps, so this test is purely about ORDER, not match outcome.
        for (const row of check.jdKeywordCoverage) {
            expect(row.present).toBe(false);
            expect(row.tier).toBe('none');
        }
    });
});
