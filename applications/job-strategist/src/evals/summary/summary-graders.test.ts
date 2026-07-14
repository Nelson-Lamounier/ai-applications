/** @format */
import { describe, it, expect } from '@jest/globals';
import { runSummaryGraders, noGapGrader, altitudeGrader, atsCoverageGrader } from './summary-graders.js';
import { GOLDEN_SUMMARY, GOLDEN_ATS_SUMMARY } from './fixtures.js';
import { selectSummaryAtsTargets } from '../../ats/gate/summary-ats-targets.js';

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

    it('the ATS-aware golden summary surfaces its targets AND passes every guard', () => {
        const r = runSummaryGraders(GOLDEN_ATS_SUMMARY);
        expect(r.results.filter((x) => !x.pass)).toEqual([]);
        expect(r.pass).toBe(true);
        // coverage grader specifically: >=2 of the 3 targets present
        expect(atsCoverageGrader(GOLDEN_ATS_SUMMARY).pass).toBe(true);
    });

    it('atsCoverage fails when the summary misses too many targets', () => {
        const r = atsCoverageGrader({ ...GOLDEN_ATS_SUMMARY, summary: 'Generic engineer who ships software.' });
        expect(r.pass).toBe(false);
    });

    it('atsCoverage passes vacuously when a fixture has no ATS targets', () => {
        expect(atsCoverageGrader(GOLDEN_SUMMARY).pass).toBe(true); // GOLDEN_SUMMARY has no atsTargets
    });

    it('a gap skill is never selected as an ATS target', () => {
        const ledger = [
            { tool: 'Kubernetes', status: 'verified', evidenceFiles: [], evidence: '', transferableBridge: '' },
            { tool: 'Go', status: 'gap', evidenceFiles: [], evidence: '', transferableBridge: '' },
        ] as never;
        const jd = { hardRequirements: [{ skill: 'Kubernetes', disqualifying: true }, { skill: 'Go', disqualifying: true }] };
        const targets = selectSummaryAtsTargets(ledger, jd, 3);
        expect(targets.map((t) => t.skill)).toContain('Kubernetes');
        expect(targets.map((t) => t.skill)).not.toContain('Go');
    });
});
