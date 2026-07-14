/** @format */
import type { S3Client } from '@aws-sdk/client-s3';
import type { Pool } from 'pg';

import type { AtsCheckResult } from '../ats-check.schema.js';
import { storeAtsArtifacts, storeAtsCheckJson } from '../store-ats-artifacts.js';

const CHECK: AtsCheckResult = {
    machineReadable: true, standardSectionsDetected: ['Experience', 'Skills', 'Education'],
    contactDetected: { name: 'Jane Doe', email: 'jane@example.com' }, parseBreakers: [],
    jdKeywordCoverage: [], status: 'passed', passed: true, issues: [],
};

/** Mock pool whose connect() returns a client; the UPDATE resolves rowCount. */
function mockPool(updateRowCount = 1) {
    const release = jest.fn();
    const query = jest.fn().mockImplementation((sql: string) =>
        Promise.resolve(/UPDATE resumes/i.test(sql) ? { rowCount: updateRowCount } : { rowCount: 0 }),
    );
    const connect = jest.fn().mockResolvedValue({ query, release });
    return { pool: { connect } as unknown as Pool, connect, query, release };
}

describe('storeAtsArtifacts', () => {
    it('uploads the PDF and updates the resumes row inside the RLS context', async () => {
        const put = jest.fn().mockResolvedValue({});
        const s3 = { send: put } as unknown as S3Client;
        const { pool, connect, query, release } = mockPool(1);

        const key = await storeAtsArtifacts({
            s3, pool, bucket: 'assets-bucket', resumeId: 'r-1', userId: 'u-1',
            pdf: Buffer.from('%PDF-1.7 test'), check: CHECK,
        });

        expect(key).toBe('resumes/u-1/r-1.pdf');
        expect(put).toHaveBeenCalledTimes(1);
        expect(connect).toHaveBeenCalledTimes(1);
        // RLS context is set in the SAME transaction as the UPDATE.
        expect(query.mock.calls.map((c) => c[0])).toEqual(
            expect.arrayContaining([
                'BEGIN',
                expect.stringMatching(/set_config\('app\.current_user_id'/),
                expect.stringMatching(/UPDATE resumes/i),
                'COMMIT',
            ]),
        );
        const updateCall = query.mock.calls.find((c) => /UPDATE resumes/i.test(c[0] as string));
        expect(updateCall?.[1]).toEqual(['resumes/u-1/r-1.pdf', JSON.stringify(CHECK), 'r-1']);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('throws (not silently) when the UPDATE matches 0 rows — RLS/id mismatch', async () => {
        const s3 = { send: jest.fn().mockResolvedValue({}) } as unknown as S3Client;
        const { pool, release } = mockPool(0);

        await expect(
            storeAtsArtifacts({
                s3, pool, bucket: 'assets-bucket', resumeId: 'r-1', userId: 'u-1',
                pdf: Buffer.from('%PDF-1.7 test'), check: CHECK,
            }),
        ).rejects.toThrow(/0 rows/i);
        expect(release).toHaveBeenCalledTimes(1); // connection returned even on failure
    });
});

describe('storeAtsCheckJson (F6 — re-store the attainable-enriched check)', () => {
    const ENRICHED: AtsCheckResult = {
        ...CHECK,
        attainableTotal:   3,
        attainableCovered: 2,
        attainablePassed:  true,
        surfacedKeywords:  ['AWS'],
    };

    it('updates only ats_check_json (no pdf_s3_key) inside the RLS context, carrying attainablePassed', async () => {
        const { pool, connect, query, release } = mockPool(1);

        await storeAtsCheckJson({ pool, resumeId: 'r-1', userId: 'u-1', check: ENRICHED });

        expect(connect).toHaveBeenCalledTimes(1);
        expect(query.mock.calls.map((c) => c[0])).toEqual(
            expect.arrayContaining([
                'BEGIN',
                expect.stringMatching(/set_config\('app\.current_user_id'/),
                expect.stringMatching(/UPDATE resumes SET ats_check_json/i),
                'COMMIT',
            ]),
        );
        const updateCall = query.mock.calls.find((c) => /UPDATE resumes/i.test(c[0] as string));
        expect(updateCall?.[0]).not.toMatch(/pdf_s3_key/i);
        const bindParams = updateCall?.[1] as unknown[];
        expect(bindParams).toEqual([JSON.stringify(ENRICHED), 'r-1']);
        const persisted = JSON.parse(bindParams[0] as string) as AtsCheckResult;
        expect(persisted.attainablePassed).toBe(true);
        expect(persisted.attainableTotal).toBe(3);
        expect(persisted.attainableCovered).toBe(2);
        expect(persisted.surfacedKeywords).toEqual(['AWS']);
        expect(release).toHaveBeenCalledTimes(1);
    });

    it('throws (not silently) when the UPDATE matches 0 rows — RLS/id mismatch', async () => {
        const { pool, release } = mockPool(0);

        await expect(
            storeAtsCheckJson({ pool, resumeId: 'r-1', userId: 'u-1', check: ENRICHED }),
        ).rejects.toThrow(/0 rows/i);
        expect(release).toHaveBeenCalledTimes(1);
    });
});
