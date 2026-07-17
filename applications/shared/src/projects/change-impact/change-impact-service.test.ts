/** @format */
import { describe, it, expect } from '@jest/globals';
import { narrateFileChangeImpact } from './change-impact-service.js';
import type { ChangeImpactStore } from './change-impact-service.js';
import type { FileChange, PerfMetric } from '../../rds/implementations/RdsRepoActivityStore.js';

const HISTORY: FileChange[] = [
    { commitSha: 'new', status: 'modified', additions: 10, deletions: 4, changes: 14, patch: '@@\n+  if (x) y();', patchTruncated: false, authoredAt: '2026-02-01T00:00:00Z', message: 'tune loop' },
    { commitSha: 'old', status: 'added',    additions: 3,  deletions: 1, changes: 4,  patch: '@@\n-  for (a of b) c();', patchTruncated: false, authoredAt: '2026-01-01T00:00:00Z', message: 'init' },
];

const perfFor = (sha: string): PerfMetric[] =>
    sha === 'old' ? [{ commitSha: 'old', metricName: 'p95_latency_ms', value: 1200, unit: 'ms', source: 'ci-benchmark', measuredAt: 'x' }]
    : sha === 'new' ? [{ commitSha: 'new', metricName: 'p95_latency_ms', value: 400, unit: 'ms', source: 'ci-benchmark', measuredAt: 'y' }]
    : [];

const store: ChangeImpactStore = {
    getFileChanges:  async () => HISTORY,
    getMeasuredPerf: async (_u, _r, sha) => perfFor(sha),
};

describe('narrateFileChangeImpact (query-time consumer)', () => {
    it('assembles the report from history + measured perf and narrates it grounded', async () => {
        const out = await narrateFileChangeImpact(store, 'u', 'o/r', 'src/loop.ts', { invoke: async () => ({ summary: 'Loop simplified.', performanceLine: 'Latency down.' }) });
        expect(out).not.toBeNull();
        expect(out!.report.filePath).toBe('src/loop.ts');
        expect(out!.report.structural.churn).toBe(18);          // (10+4)+(3+1)
        expect(out!.report.hasMeasuredPerf).toBe(true);          // old=1200, new=400 both measured
        expect(out!.report.performance[0]!.percentChange).toBeCloseTo(-66.67, 1);
        expect(out!.narration.grounded).toBe(true);
        expect(out!.narration.source).toBe('model');
    });

    it('compares perf between the OLDEST and NEWEST commits touching the file', async () => {
        const seen: string[] = [];
        const spy: ChangeImpactStore = { getFileChanges: async () => HISTORY, getMeasuredPerf: async (_u, _r, sha) => { seen.push(sha); return perfFor(sha); } };
        await narrateFileChangeImpact(spy, 'u', 'o/r', 'src/loop.ts', { invoke: async () => ({ summary: '', performanceLine: '' }) });
        expect(seen).toEqual(expect.arrayContaining(['old', 'new'])); // before = oldest, after = newest
    });

    it('returns null when the file has no change history', async () => {
        const empty: ChangeImpactStore = { ...store, getFileChanges: async () => [] };
        expect(await narrateFileChangeImpact(empty, 'u', 'o/r', 'nope.ts', {})).toBeNull();
    });

    it('narrates with NO percentage when nothing was measured', async () => {
        const noPerf: ChangeImpactStore = { ...store, getMeasuredPerf: async () => [] };
        const out = await narrateFileChangeImpact(noPerf, 'u', 'o/r', 'src/loop.ts', { invoke: async () => { throw new Error('force deterministic'); } });
        expect(out!.report.hasMeasuredPerf).toBe(false);
        expect(out!.narration.performanceLine).not.toMatch(/%/);
    });
});
