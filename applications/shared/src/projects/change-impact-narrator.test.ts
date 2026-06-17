/** @format */
import { describe, it, expect } from '@jest/globals';
import { narrateChangeImpact } from './change-impact-narrator.js';
import { isGrounded } from './change-impact-grounding.js';
import type { ChangeImpactReport } from './change-metrics.js';

const report = (over: Partial<ChangeImpactReport> = {}): ChangeImpactReport => ({
    filePath: 'src/loop.ts',
    structural: { filePath: 'src/loop.ts', changeCount: 2, churn: 42, netLoc: 18, complexityDelta: -3, lastChangedAt: '2026-02-01T00:00:00Z' },
    performance: [{ metric: 'p95_latency_ms', unit: 'ms', before: 1200, after: 400, percentChange: -66.67 }],
    hasMeasuredPerf: true,
    ...over,
});

describe('narrateChangeImpact', () => {
    it('accepts a model narration that cites only grounded numbers', async () => {
        const invoke = async () => ({ summary: 'Cut 3 branches across 2 commits; 42 lines churned.', performanceLine: 'p95 1200ms → 400ms (−66.7%).' });
        const out = await narrateChangeImpact(report(), { invoke });
        expect(out.source).toBe('model');
        expect(out.grounded).toBe(true);
        expect(out.summary).toContain('branches');
    });

    it('rejects a fabricated model narration and falls back to deterministic facts', async () => {
        const invoke = async () => ({ summary: 'Roughly 40% faster and 99 bugs fixed.', performanceLine: '50% improvement.' });
        const out = await narrateChangeImpact(report(), { invoke });
        expect(out.source).toBe('deterministic');
        expect(out.grounded).toBe(true);
        // The SERVED output must cite only real numbers.
        expect(isGrounded(`${out.summary}\n${out.performanceLine}`, report())).toBe(true);
        expect(`${out.summary} ${out.performanceLine}`).not.toContain('99');
    });

    it('falls back deterministically when the model call throws', async () => {
        const invoke = async () => { throw new Error('bedrock down'); };
        const out = await narrateChangeImpact(report(), { invoke });
        expect(out.source).toBe('deterministic');
        expect(out.grounded).toBe(true);
        expect(isGrounded(`${out.summary}\n${out.performanceLine}`, report())).toBe(true);
    });

    it('claims NO percentage when there is no measured perf', async () => {
        const invoke = async () => { throw new Error('force deterministic'); };
        const out = await narrateChangeImpact(report({ performance: [], hasMeasuredPerf: false }), { invoke });
        expect(out.performanceLine.toLowerCase()).toMatch(/no measure|no percentage|not measured/);
        expect(out.performanceLine).not.toMatch(/%/);
    });
});
