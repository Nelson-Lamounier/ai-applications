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
        const { seoResearch, ...noSeo } = VALID;
        const r = validateArticleResearch(noSeo);
        expect(r.seoResearch).toBeUndefined();
        expect(r.outline).toHaveLength(1);
    });

    it('throws fast when a required field is missing', () => {
        const { outline, ...broken } = VALID;
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
});
