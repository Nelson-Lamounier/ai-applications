/**
 * @format
 * Article Research Agent — schema validation safety-net tests.
 */

import type { validateArticleResearch as ValidateArticleResearchFn } from './research-agent.js';

// research-agent.ts throws at module load if RESEARCH_MODEL is unset.
process.env['RESEARCH_MODEL'] = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

let validateArticleResearch: typeof ValidateArticleResearchFn;

beforeAll(async () => {
    ({ validateArticleResearch } = await import('./research-agent.js'));
});

const VALID = {
    outline: [{ heading: 'Intro', wordBudget: 200, keyPoints: ['hook'], needsVisual: false }],
    technicalFacts: ['EKS uses etcd'],
    suggestedTitle: 'Scaling EKS',
    suggestedTags: ['aws', 'kubernetes'],
    seoResearch: {
        primaryKeyword: 'eks scaling',
        secondaryKeywords: ['karpenter', 'cluster autoscaler'],
        suggestedReferences: [{ label: 'AWS Docs', url: 'https://docs.aws.amazon.com', relevance: 'official' }],
    },
};

describe('validateArticleResearch', () => {
    it('returns typed model output and defaults usedInline=false on references', () => {
        const r = validateArticleResearch(VALID);
        expect(r.outline).toHaveLength(1);
        expect(r.suggestedTitle).toBe('Scaling EKS');
        expect(r.seoResearch?.suggestedReferences[0].usedInline).toBe(false);
    });

    it('omits seoResearch entirely when absent (optional)', () => {
        const { seoResearch: _seoResearch, ...noSeo } = VALID;
        const r = validateArticleResearch(noSeo);
        expect(r.seoResearch).toBeUndefined();
        expect(r.outline).toHaveLength(1);
    });

    it('throws fast when a required field is missing', () => {
        const { outline: _outline, ...broken } = VALID;
        expect(() => validateArticleResearch(broken)).toThrow(/schema validation/i);
    });

    it('throws fast when the model injects an unknown field', () => {
        expect(() => validateArticleResearch({ ...VALID, injected: 'nope' }))
            .toThrow(/schema validation/i);
    });

    it('throws fast when seoResearch is present but malformed', () => {
        expect(() => validateArticleResearch({ ...VALID, seoResearch: { primaryKeyword: 123 } }))
            .toThrow(/schema validation/i);
    });

    // ── Evidence-driven archetype fields (Phase 2, all optional) ─────────────

    it('passes through the evidence inventory + brief fields when present', () => {
        const withEvidence = {
            ...VALID,
            evidenceInventory: {
                failureNarratives: 3, metrics: 4, comparisons: 0, stepSequences: 1,
                decisionRecords: 2, deepLinks: 3, diagnosticArtifacts: 2,
            },
            citableLinks: [{ url: 'https://docs.aws.amazon.com/x', supportsClaim: 'hop limit' }],
            publicRepos: ['cdk-monitoring'],
            publishIdentifiers: [],
            availableMetrics: [{ value: '11 minutes', measures: 'deploy time saved' }],
        };
        const r = validateArticleResearch(withEvidence);
        expect(r.evidenceInventory?.failureNarratives).toBe(3);
        expect(r.citableLinks?.[0].supportsClaim).toBe('hop limit');
        expect(r.availableMetrics?.[0].value).toBe('11 minutes');
        expect(r.publicRepos).toEqual(['cdk-monitoring']);
    });

    it('leaves the evidence fields undefined when the model omits them (legacy path)', () => {
        const r = validateArticleResearch(VALID);
        expect(r.evidenceInventory).toBeUndefined();
        expect(r.citableLinks).toBeUndefined();
        expect(r.availableMetrics).toBeUndefined();
    });

    it('throws when evidenceInventory is present but malformed', () => {
        expect(() => validateArticleResearch({ ...VALID, evidenceInventory: { failureNarratives: 'lots' } }))
            .toThrow(/schema validation/i);
    });

    // ── Array-field coercion (forced tool_use does not guarantee nested arrays) ──
    // Regression for run af9b983b: the model returned `citableLinks` as a bare
    // string, a plain z.array rejected it, and the whole research brief failed
    // schema validation — aborting the pipeline before the Writer ran.
    describe('coerces a stringified array field instead of hard-failing', () => {
        it('coerces citableLinks: "" to [] (the live failure shape)', () => {
            const r = validateArticleResearch({ ...VALID, citableLinks: '' });
            expect(r.citableLinks).toEqual([]);
        });

        it('coerces citableLinks: "none" / "n/a" to []', () => {
            expect(validateArticleResearch({ ...VALID, citableLinks: 'none' }).citableLinks).toEqual([]);
            expect(validateArticleResearch({ ...VALID, citableLinks: 'N/A' }).citableLinks).toEqual([]);
        });

        it('parses a JSON-stringified citableLinks array', () => {
            const links = [{ url: 'https://docs.aws.amazon.com', supportsClaim: 'official docs' }];
            const r = validateArticleResearch({ ...VALID, citableLinks: JSON.stringify(links) });
            expect(r.citableLinks).toEqual(links);
        });

        it('preserves a well-formed citableLinks array unchanged', () => {
            const links = [{ url: 'https://example.com', supportsClaim: 'x' }];
            expect(validateArticleResearch({ ...VALID, citableLinks: links }).citableLinks).toEqual(links);
        });

        it('drops a non-JSON string to [] rather than smuggling it in as a link', () => {
            const r = validateArticleResearch({ ...VALID, citableLinks: 'see the appendix' });
            expect(r.citableLinks).toEqual([]);
        });

        it('applies the same coercion to seoResearch.suggestedReferences and availableMetrics', () => {
            const r = validateArticleResearch({
                ...VALID,
                seoResearch: { ...VALID.seoResearch, suggestedReferences: '' },
                availableMetrics: 'none',
            });
            expect(r.seoResearch?.suggestedReferences).toEqual([]);
            expect(r.availableMetrics).toEqual([]);
        });

        it('still rejects a genuinely wrong type (number) for an array field', () => {
            expect(() => validateArticleResearch({ ...VALID, citableLinks: 42 }))
                .toThrow(/schema validation/i);
        });
    });
});
