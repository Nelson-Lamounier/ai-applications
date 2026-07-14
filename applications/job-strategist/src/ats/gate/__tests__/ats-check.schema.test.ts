/** @format */
import { AtsCheckResultSchema } from '../ats-check.schema.js';

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

    it('round-trips the optional attainable fields (F5/F6)', () => {
        const payload = {
            machineReadable: true,
            standardSectionsDetected: ['Experience', 'Skills', 'Education'],
            contactDetected: { name: 'Jane Doe', email: 'jane@example.com' },
            parseBreakers: [],
            jdKeywordCoverage: [{ term: 'Kubernetes', present: true, grounded: true }],
            status: 'issues',
            passed: false,
            issues: ['Grounded JD must-have "AWS" missing from resume.'],
            attainableTotal: 3,
            attainableCovered: 2,
            attainablePassed: true,
            surfacedKeywords: ['AWS'],
        };
        const r = AtsCheckResultSchema.safeParse(payload);
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.attainableTotal).toBe(3);
            expect(r.data.attainableCovered).toBe(2);
            expect(r.data.attainablePassed).toBe(true);
            expect(r.data.surfacedKeywords).toEqual(['AWS']);
        }
    });

    it('accepts a result with the attainable fields omitted (back-compat)', () => {
        const r = AtsCheckResultSchema.safeParse({
            machineReadable: true, standardSectionsDetected: [], contactDetected: { name: '', email: '' },
            parseBreakers: [], jdKeywordCoverage: [], status: 'passed', passed: true, issues: [],
        });
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.attainablePassed).toBeUndefined();
        }
    });
});
