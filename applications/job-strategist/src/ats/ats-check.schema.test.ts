/** @format */
import { AtsCheckResultSchema } from './ats-check.schema.js';

describe('AtsCheckResultSchema', () => {
    it('accepts a well-formed passed result', () => {
        const r = AtsCheckResultSchema.safeParse({
            machineReadable: true,
            standardSectionsDetected: ['Experience', 'Skills', 'Education'],
            contactDetected: { name: 'Jane Doe', email: 'jane@example.com' },
            parseBreakers: [],
            jdKeywordCoverage: [{ term: 'Kubernetes', present: true, grounded: true }],
            status: 'passed',
            passed: true,
            issues: [],
        });
        expect(r.success).toBe(true);
    });

    it('rejects an invalid status', () => {
        const r = AtsCheckResultSchema.safeParse({
            machineReadable: true, standardSectionsDetected: [], contactDetected: { name: '', email: '' },
            parseBreakers: [], jdKeywordCoverage: [], status: 'maybe', passed: false, issues: [],
        });
        expect(r.success).toBe(false);
    });
});
