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

    // Verified Python drives the pass; transferable OpenAI is bonus-only (never blocks).
    // A Kubernetes gap (when present) must stay excluded from the pass universe.
    it.each([
        { name: 'verified present, transferable absent → pass', py: true, oai: false, total: 1, covered: 1, passed: true },
        { name: 'verified absent → blocks even though transferable also absent', py: false, oai: false, total: 1, covered: 0, passed: false },
        { name: 'verified + transferable both present → pass (gap still excluded)', py: true, oai: true, total: 1, covered: 1, passed: true },
    ])('verified-only pass bar: $name', ({ py, oai, total, covered, passed }) => {
        const coverage = [
            { term: 'Python', present: py },
            { term: 'OpenAI API', present: oai },
            { term: 'Kubernetes', present: false },
        ];
        const ledger = [entry('Python', 'verified'), entry('OpenAI API', 'transferable'), entry('Kubernetes', 'gap')];
        const r = splitAttainable(coverage, ledger);
        expect(r.attainableTotal).toBe(total);
        expect(r.attainableCovered).toBe(covered);
        expect(r.attainablePassed).toBe(passed);
    });

    it('when verified + transferable are both missing, BOTH are surfaced (gap excluded)', () => {
        const coverage = [
            { term: 'Python', present: false },
            { term: 'OpenAI API', present: false },
            { term: 'Kubernetes', present: false },
        ];
        const ledger = [entry('Python', 'verified'), entry('OpenAI API', 'transferable'), entry('Kubernetes', 'gap')];
        const missing = splitAttainable(coverage, ledger).attainableMissing.map((e) => e.tool);
        expect(missing.toSorted((a, b) => a.localeCompare(b))).toEqual(['OpenAI API', 'Python']);
    });

    it('gap tool absent → NEVER attainable (excluded entirely, honesty invariant)', () => {
        const r = splitAttainable([{ term: 'Kubernetes', present: false }], [entry('Kubernetes', 'gap')]);
        expect(r.attainableTotal).toBe(0);
        expect(r.attainableCovered).toBe(0);
        expect(r.attainableMissing).toHaveLength(0);
        expect(r.attainablePassed).toBe(true); // no verified missing
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
