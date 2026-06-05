/** @format */
import type { S3Client } from '@aws-sdk/client-s3';
import type { Pool } from 'pg';

import type { AtsCheckResult } from './ats-check.schema.js';
import { storeAtsArtifacts } from './store-ats-artifacts.js';

const CHECK: AtsCheckResult = {
    machineReadable: true, standardSectionsDetected: ['Experience', 'Skills', 'Education'],
    contactDetected: { name: 'Jane Doe', email: 'jane@example.com' }, parseBreakers: [],
    jdKeywordCoverage: [], status: 'passed', passed: true, issues: [],
};

describe('storeAtsArtifacts', () => {
    it('uploads the PDF and updates the resumes row idempotently', async () => {
        const put = jest.fn().mockResolvedValue({});
        const s3 = { send: put } as unknown as S3Client;
        const query = jest.fn().mockResolvedValue({ rowCount: 1 });
        const pool = { query } as unknown as Pool;

        const key = await storeAtsArtifacts({
            s3, pool, bucket: 'assets-bucket', resumeId: 'r-1', userId: 'u-1',
            pdf: Buffer.from('%PDF-1.7 test'), check: CHECK,
        });

        expect(key).toBe('resumes/u-1/r-1.pdf');
        expect(put).toHaveBeenCalledTimes(1);
        expect(query).toHaveBeenCalledTimes(1);
        const sql = query.mock.calls[0][0] as string;
        expect(sql).toMatch(/UPDATE resumes/i);
        expect(query.mock.calls[0][1]).toEqual(['resumes/u-1/r-1.pdf', JSON.stringify(CHECK), 'r-1']);
    });
});
