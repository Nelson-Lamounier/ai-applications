/** @format */
import type { S3Client } from '@aws-sdk/client-s3';
import type { StrategistResearchResult, StructuredResumeData } from '@bedrock/shared';
import type { Pool } from 'pg';

import { renderCheckAndStoreAts, type AtsLogger } from './run-ats-check.js';

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
