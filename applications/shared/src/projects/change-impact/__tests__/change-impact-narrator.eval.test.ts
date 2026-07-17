/**
 * @format
 * change-impact-narrator eval — the anti-fabrication guarantee.
 *
 * Per the repo LLM-workflow rule, the narration phase ships with an eval that
 * defines "good output": across a corpus of reports, the SERVED narration must
 * never cite a number absent from its report — whatever the model returns. This
 * is the contract the whole grounded-change-impact design rests on.
 */
import { describe, it, expect } from '@jest/globals';
import { narrateChangeImpact, buildDeterministicNarration } from '../change-impact-narrator.js';
import { isGrounded } from '../change-impact-grounding.js';
import type { ChangeImpactReport } from '../change-metrics.js';

const r = (over: Partial<ChangeImpactReport>): ChangeImpactReport => ({
    filePath: 'src/x.ts',
    structural: { filePath: 'src/x.ts', changeCount: 1, churn: 0, netLoc: 0, complexityDelta: 0, lastChangedAt: null },
    performance: [],
    hasMeasuredPerf: false,
    ...over,
});

const CORPUS: ChangeImpactReport[] = [
    r({ structural: { filePath: 'a', changeCount: 3, churn: 120, netLoc: 60, complexityDelta: -7, lastChangedAt: 'x' },
        performance: [{ metric: 'p95_latency_ms', unit: 'ms', before: 900, after: 300, percentChange: -66.67 }], hasMeasuredPerf: true }),
    r({ structural: { filePath: 'b', changeCount: 2, churn: 8, netLoc: -4, complexityDelta: 5, lastChangedAt: 'x' } }), // no perf, more branches
    r({ structural: { filePath: 'c', changeCount: 1, churn: 2, netLoc: 2, complexityDelta: 0, lastChangedAt: 'x' } }),  // trivial
    r({ structural: { filePath: 'd', changeCount: 10, churn: 5000, netLoc: 4096, complexityDelta: -1, lastChangedAt: 'x' },
        performance: [{ metric: 'throughput_rps', unit: 'rps', before: 100, after: 150, percentChange: 50 }], hasMeasuredPerf: true }),
];

/** A model that fabricates — invents figures nowhere in the report. */
const fabricate = async () => ({ summary: 'About 12345% faster, fixed 9999 bugs, 73% less memory.', performanceLine: '88% improvement.' });

describe('change-impact-narrator eval — served output is always grounded', () => {
    it('the deterministic narration cites only report numbers for every report', () => {
        for (const report of CORPUS) {
            const det = buildDeterministicNarration(report);
            expect(isGrounded(`${det.summary}\n${det.performanceLine}`, report)).toBe(true);
        }
    });

    it('a fabricating model is always rejected → served output stays grounded', async () => {
        for (const report of CORPUS) {
            const out = await narrateChangeImpact(report, { invoke: fabricate });
            expect(out.source).toBe('deterministic');
            expect(isGrounded(`${out.summary}\n${out.performanceLine}`, report)).toBe(true);
            expect(`${out.summary} ${out.performanceLine}`).not.toMatch(/9999|12345|88%/);
        }
    });

    it('a grounded model narration is accepted as-is', async () => {
        for (const report of CORPUS) {
            // Echo the deterministic (grounded) narration as if the model produced it.
            const out = await narrateChangeImpact(report, { invoke: async () => buildDeterministicNarration(report) });
            expect(out.source).toBe('model');
            expect(out.grounded).toBe(true);
        }
    });

    it('never claims a percentage when no perf was measured', async () => {
        const noPerf = CORPUS.filter((c) => !c.hasMeasuredPerf);
        for (const report of noPerf) {
            const out = await narrateChangeImpact(report, { invoke: fabricate });
            expect(out.performanceLine).not.toMatch(/%/);
        }
    });
});
