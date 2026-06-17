/** @format */
import { describe, it, expect } from '@jest/globals';
import { allowedNumbersFor, findUngroundedNumbers, isGrounded } from './change-impact-grounding.js';
import type { ChangeImpactReport } from './change-metrics.js';

const report: ChangeImpactReport = {
    filePath: 'src/loop.ts',
    structural: { filePath: 'src/loop.ts', changeCount: 2, churn: 42, netLoc: 18, complexityDelta: -3, lastChangedAt: '2026-02-01T00:00:00Z' },
    performance: [{ metric: 'p95_latency_ms', unit: 'ms', before: 1200, after: 400, percentChange: -66.67 }],
    hasMeasuredPerf: true,
};

describe('allowedNumbersFor', () => {
    it('collects every citable number (and its magnitude) from the report', () => {
        const allowed = allowedNumbersFor(report);
        for (const n of [2, 42, 18, -3, 3, 1200, 400, -66.67, 66.67]) {
            expect(allowed.has(n)).toBe(true);
        }
    });
});

describe('findUngroundedNumbers', () => {
    const allowed = allowedNumbersFor(report);

    it('passes text that only cites grounded numbers', () => {
        expect(findUngroundedNumbers('Net +18 lines, 42 churned, 2 commits, 3 fewer branches.', allowed)).toEqual([]);
    });

    it('tolerates display rounding of a measured percentage', () => {
        // -66.67% shown as "66.7%" or "67%" is grounded; the wrong-rounding "66%" is not.
        expect(findUngroundedNumbers('Latency fell 66.7%.', allowed)).toEqual([]);
        expect(findUngroundedNumbers('Latency fell 67%.', allowed)).toEqual([]);
    });

    it('flags a fabricated number not in the report', () => {
        expect(findUngroundedNumbers('Roughly 50% faster and 99 bugs fixed.', allowed)).toEqual(expect.arrayContaining([50, 99]));
    });

    it('flags a measured value that was misquoted', () => {
        expect(findUngroundedNumbers('Latency went from 1200ms to 350ms.', allowed)).toEqual([350]);
    });
});

describe('isGrounded', () => {
    it('is true only when no fabricated number appears', () => {
        expect(isGrounded('Cut 3 branches; p95 1200ms → 400ms (−66.7%).', report)).toBe(true);
        expect(isGrounded('Made it 40% faster.', report)).toBe(false);
    });
});
