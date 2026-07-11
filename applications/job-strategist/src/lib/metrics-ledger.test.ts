/**
 * @format
 * Grounded-metrics ledger — deterministic extraction of number-bearing
 * sentences from the candidate's own case-study rows. The supply side of the
 * metric honesty loop: the writer may only use numbers that appear here (or in
 * the other evidence blocks), so extraction must preserve sentences verbatim.
 */
import { describe, it, expect } from '@jest/globals';
import { extractMetricSentences, formatMetricsLedger, resumeHasMetric, composeMetricsBlock } from './metrics-ledger.js';

describe('extractMetricSentences', () => {
    it('keeps only sentences that carry a number, verbatim', () => {
        const text =
            'The skills overlap lane was near-dead. Measured at 2.2% canonical coverage across 17,138 surface-forms. Retrieval now uses the ontology.';
        expect(extractMetricSentences(text)).toEqual([
            'Measured at 2.2% canonical coverage across 17,138 surface-forms.',
        ]);
    });

    it('returns [] for number-free text', () => {
        expect(extractMetricSentences('Enabled managed control-plane and elastic scaling.')).toEqual([]);
    });

    it('does not treat bare years or dates as metrics', () => {
        expect(extractMetricSentences('Joined the team in 2022. Shipped the platform on 2026-07-04.')).toEqual([]);
    });

    it('keeps a sentence mixing a date and a real metric', () => {
        const s = 'A live assessment on 2026-07-04 rated the site at 85% overall with 132 ms LCP.';
        expect(extractMetricSentences(s)).toEqual([s]);
    });

    it('handles multi-line prose and trims whitespace', () => {
        const text = 'First line has no figures.\nSecond line cut p95 latency by 40%.\n';
        expect(extractMetricSentences(text)).toEqual(['Second line cut p95 latency by 40%.']);
    });
});

describe('formatMetricsLedger', () => {
    const rows = [
        { project: 'tucaken', text: 'Coverage rose from 2.2% to 96% after enrichment. No other change.' },
        { project: 'portfolio', text: 'Pages render in 132 ms (LCP) with a 40 ms TTFB.' },
        { project: 'portfolio', text: 'Purely qualitative sentence.' },
    ];

    it('emits one attributed line per metric sentence', () => {
        const block = formatMetricsLedger(rows);
        expect(block).toContain('GROUNDED METRICS');
        expect(block).toContain('- [tucaken] Coverage rose from 2.2% to 96% after enrichment.');
        expect(block).toContain('- [portfolio] Pages render in 132 ms (LCP) with a 40 ms TTFB.');
    });

    it('returns empty string when no row yields a metric sentence', () => {
        expect(formatMetricsLedger([{ project: 'p', text: 'Qualitative only.' }])).toBe('');
    });

    it('caps the ledger to the given maximum lines', () => {
        const many = Array.from({ length: 40 }, (_, i) => ({ project: 'p', text: `Cut latency by ${i + 1}%.` }));
        const block = formatMetricsLedger(many, 10);
        expect(block.split('\n').filter((l) => l.startsWith('- ')).length).toBe(10);
    });
});

describe('resumeHasMetric', () => {
    const base = {
        summary: 'Platform engineer.',
        experience: [{ company: 'X', title: 'Y', period: '2021 - 2022', highlights: ['Built the deploy pipeline.'] }],
        keyAchievements: [],
    } as never;

    it('false when summary and highlights carry no unit-bearing number', () => {
        expect(resumeHasMetric(base)).toBe(false);
    });

    it('true when a highlight carries a percentage', () => {
        const r = structuredClone(base) as { experience: Array<{ highlights: string[] }> };
        r.experience[0]!.highlights.push('Cut build time by 40%.');
        expect(resumeHasMetric(r as never)).toBe(true);
    });

    it('true when a highlight carries a time metric', () => {
        const r = structuredClone(base) as { experience: Array<{ highlights: string[] }> };
        r.experience[0]!.highlights.push('Reduced deploys from 8 minutes to 30 seconds.');
        expect(resumeHasMetric(r as never)).toBe(true);
    });

    it('periods and bare years do not count as metrics', () => {
        const r = structuredClone(base) as { summary: string };
        r.summary = 'Engineer since 2019 across 2 employers.';
        expect(resumeHasMetric(r as never)).toBe(false);
    });
});

describe('composeMetricsBlock', () => {
    it('appends KB pass-through sentences as [KB] lines under the ledger', () => {
        const block = composeMetricsBlock(
            '### GROUNDED METRICS\n- [p] Cut latency by 40%.',
            ['Coverage rose to 96% after enrichment.'],
        );
        expect(block).toContain('- [p] Cut latency by 40%.');
        expect(block).toContain('- [KB] Coverage rose to 96% after enrichment.');
    });

    it('builds a headed block from KB sentences alone when the ledger is empty', () => {
        const block = composeMetricsBlock('', ['Cut p95 by 40%.']);
        expect(block).toContain('GROUNDED METRICS');
        expect(block).toContain('- [KB] Cut p95 by 40%.');
    });

    it('drops KB sentences without a metric-grade number (matcher drift)', () => {
        const block = composeMetricsBlock('', ['Strong Kubernetes experience.', 'Joined in 2022.']);
        expect(block).toBe('');
    });

    it('returns empty when both sources are empty', () => {
        expect(composeMetricsBlock('', [])).toBe('');
    });
});
