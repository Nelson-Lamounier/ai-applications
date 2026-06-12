/** @format */
import { splitAttainable } from './attainable.js';
import type { SkillEvidenceEntry } from '@bedrock/shared';

const entry = (
    tool: string,
    status: SkillEvidenceEntry['status'],
    extra: Partial<SkillEvidenceEntry> = {},
): SkillEvidenceEntry => ({
    tool,
    status,
    evidenceFiles: extra.evidenceFiles ?? [],
    evidence: extra.evidence ?? '',
    transferableBridge: extra.transferableBridge ?? '',
});

describe('splitAttainable', () => {
    it('verified tool present in coverage → covered, not missing', () => {
        const coverage = [{ term: 'Python', present: true }];
        const ledger = [entry('Python', 'verified')];
        const r = splitAttainable(coverage, ledger);
        expect(r.attainableTotal).toBe(1);
        expect(r.attainableCovered).toBe(1);
        expect(r.attainableMissing).toHaveLength(0);
        expect(r.attainablePassed).toBe(true);
    });

    it('verified tool absent from resume (present=false) → attainableMissing', () => {
        const coverage = [{ term: 'Python', present: false }];
        const ledger = [entry('Python', 'verified')];
        const r = splitAttainable(coverage, ledger);
        expect(r.attainableTotal).toBe(1);
        expect(r.attainableCovered).toBe(0);
        expect(r.attainableMissing.map((e) => e.tool)).toEqual(['Python']);
        expect(r.attainablePassed).toBe(false);
    });

    it('transferable tool absent → attainableMissing (candidate can transfer it)', () => {
        const coverage = [{ term: 'OpenAI API', present: false }];
        const ledger = [entry('OpenAI API', 'transferable', { transferableBridge: 'AWS Bedrock/Claude transfers' })];
        const r = splitAttainable(coverage, ledger);
        expect(r.attainableMissing.map((e) => e.tool)).toEqual(['OpenAI API']);
        expect(r.attainablePassed).toBe(false);
    });

    it('gap tool absent → NEVER attainable (excluded entirely, honesty invariant)', () => {
        const coverage = [{ term: 'Kubernetes', present: false }];
        const ledger = [entry('Kubernetes', 'gap')];
        const r = splitAttainable(coverage, ledger);
        expect(r.attainableTotal).toBe(0);
        expect(r.attainableCovered).toBe(0);
        expect(r.attainableMissing).toHaveLength(0);
        expect(r.attainablePassed).toBe(true); // no attainable missing
    });

    it('attainablePassed true when none missing (all attainable present)', () => {
        const coverage = [
            { term: 'Python', present: true },
            { term: 'OpenAI API', present: true },
            { term: 'Kubernetes', present: false },
        ];
        const ledger = [
            entry('Python', 'verified'),
            entry('OpenAI API', 'transferable'),
            entry('Kubernetes', 'gap'),
        ];
        const r = splitAttainable(coverage, ledger);
        expect(r.attainableTotal).toBe(2);
        expect(r.attainableCovered).toBe(2);
        expect(r.attainablePassed).toBe(true);
    });

    it('matches coverage term to tool case-insensitively / bidirectionally', () => {
        // ledger tool "Python" vs coverage term "Python scripting" — matchTier1 both directions.
        const coverage = [{ term: 'Python scripting', present: false }];
        const ledger = [entry('Python', 'verified')];
        const r = splitAttainable(coverage, ledger);
        expect(r.attainableMissing.map((e) => e.tool)).toEqual(['Python']);
    });

    it('attainable entry with no matching coverage term → neither covered nor missing', () => {
        const coverage = [{ term: 'Terraform', present: true }];
        const ledger = [entry('Python', 'verified')];
        const r = splitAttainable(coverage, ledger);
        expect(r.attainableTotal).toBe(1);
        expect(r.attainableCovered).toBe(0);
        expect(r.attainableMissing).toHaveLength(0);
    });
});
