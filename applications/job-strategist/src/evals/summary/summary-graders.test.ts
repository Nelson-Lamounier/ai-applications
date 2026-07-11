/** @format */
import { describe, it, expect } from '@jest/globals';
import { runSummaryGraders, noGapGrader, altitudeGrader } from './summary-graders.js';
import { GOLDEN_SUMMARY } from './fixtures.js';

describe('summary graders', () => {
    it('the golden summary passes every grader', () => {
        const r = runSummaryGraders(GOLDEN_SUMMARY);
        expect(r.results.filter((x) => !x.pass)).toEqual([]);
        expect(r.pass).toBe(true);
    });

    it('noGap fails when the summary names a shortfall', () => {
        const r = noGapGrader({ ...GOLDEN_SUMMARY, summary: 'Falls short of the 8-year bar.' });
        expect(r.pass).toBe(false);
    });

    it('altitude fails when a summary number also appears in a bullet', () => {
        const body = {
            ...GOLDEN_SUMMARY.body,
            experience: [{ company: 'A', title: 'T', period: 'p', highlights: ['cut latency by 40%'] }],
        } as typeof GOLDEN_SUMMARY.body;
        const r = altitudeGrader({ ...GOLDEN_SUMMARY, body, summary: 'Delivered a 40% improvement.' });
        expect(r.pass).toBe(false);
    });
});
