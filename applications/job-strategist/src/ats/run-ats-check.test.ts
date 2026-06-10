/** @format */
import type { S3Client } from '@aws-sdk/client-s3';
import type { StrategistResearchResult, StructuredResumeData } from '@bedrock/shared';
import type { Pool } from 'pg';

import { renderCheckAndStoreAts, type AtsLogger } from './run-ats-check.js';

const RESUME: StructuredResumeData = {
    profile: { name: 'Jane Doe', title: 'Platform Engineer', email: 'jane@example.com', location: 'Berlin' },
    summary: 'Platform engineer.',
    experience: [{ company: 'Acme', title: 'SRE', period: '2022–2026', highlights: ['Ran Kubernetes on AWS.'] }],
    skills: [{ category: 'Infra', skills: ['Kubernetes', 'AWS'] }],
    education: [{ degree: 'BSc CS', institution: 'TU Berlin', period: '2014–2018' }],
    certifications: [], projects: [], keyAchievements: [],
};

// Only the fields collectJdMustHaves/collectGroundedTerms read are needed.
const RESEARCH = {
    hardRequirements: [{ skill: 'Kubernetes', context: '' }],
    technologyInventory: { languages: [], frameworks: [], infrastructure: [], tools: [], methodologies: [] },
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
});
