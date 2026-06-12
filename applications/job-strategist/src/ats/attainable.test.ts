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

    it('transferable tool absent → surfaced but does NOT block the pass (bonus, not required)', () => {
        const coverage = [{ term: 'OpenAI API', present: false }];
        const ledger = [entry('OpenAI API', 'transferable', { transferableBridge: 'AWS Bedrock/Claude transfers' })];
        const r = splitAttainable(coverage, ledger);
        // Still surfaced (honest bridge attempt)…
        expect(r.attainableMissing.map((e) => e.tool)).toEqual(['OpenAI API']);
        // …but verified-only pass bar: a transferable keyword never blocks the pass.
        expect(r.attainableTotal).toBe(0);
        expect(r.attainableCovered).toBe(0);
        expect(r.attainablePassed).toBe(true);
    });

    it('verified missing BLOCKS the pass even when a transferable is also missing', () => {
        const coverage = [
            { term: 'Python', present: false },     // verified, absent → blocks
            { term: 'OpenAI API', present: false }, // transferable, absent → bonus only
        ];
        const ledger = [
            entry('Python', 'verified'),
            entry('OpenAI API', 'transferable'),
        ];
        const r = splitAttainable(coverage, ledger);
        expect(r.attainableMissing.map((e) => e.tool).sort((a, b) => a.localeCompare(b))).toEqual(['OpenAI API', 'Python']);
        expect(r.attainableTotal).toBe(1);    // only the verified Python
        expect(r.attainableCovered).toBe(0);
        expect(r.attainablePassed).toBe(false);
    });

    it('transferable missing alone → passes; verified all present', () => {
        const coverage = [
            { term: 'Python', present: true },      // verified, present
            { term: 'OpenAI API', present: false }, // transferable, absent → does not block
        ];
        const ledger = [
            entry('Python', 'verified'),
            entry('OpenAI API', 'transferable'),
        ];
        const r = splitAttainable(coverage, ledger);
        expect(r.attainableTotal).toBe(1);
        expect(r.attainableCovered).toBe(1);
        expect(r.attainablePassed).toBe(true);
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

    it('attainablePassed true when no verified missing (transferable counts as bonus only)', () => {
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
        expect(r.attainableTotal).toBe(1);   // only the verified Python is the pass universe
        expect(r.attainableCovered).toBe(1);
        expect(r.attainablePassed).toBe(true);
    });

    it('matches coverage term to tool case-insensitively / bidirectionally', () => {
        // ledger tool "Python" vs coverage term "Python scripting" — matchTier1 both directions.
        const coverage = [{ term: 'Python scripting', present: false }];
        const ledger = [entry('Python', 'verified')];
        const r = splitAttainable(coverage, ledger);
        expect(r.attainableMissing.map((e) => e.tool)).toEqual(['Python']);
    });

    it('verified entry with no matching coverage term → not a JD keyword, does not count or block', () => {
        const coverage = [{ term: 'Terraform', present: true }];
        const ledger = [entry('Python', 'verified')];
        const r = splitAttainable(coverage, ledger);
        expect(r.attainableTotal).toBe(0);   // Python is not a JD keyword here
        expect(r.attainableCovered).toBe(0);
        expect(r.attainableMissing).toHaveLength(0);
        expect(r.attainablePassed).toBe(true);
    });
});
