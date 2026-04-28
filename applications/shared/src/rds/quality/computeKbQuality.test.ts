/**
 * @format
 * computeKbQuality — pure scoring tests.
 */

import { computeKbQuality } from './computeKbQuality.js';
import type { RawChunk } from '../types.js';

function chunk(p: Partial<RawChunk> & { filePath: string; content: string }): RawChunk {
    return {
        filePath:    p.filePath,
        content:     p.content,
        chunkIndex:  p.chunkIndex  ?? 0,
        totalChunks: p.totalChunks ?? 1,
        tags:        p.tags,
        fileType:    p.fileType,
        skills:      p.skills,
    };
}

describe('computeKbQuality', () => {
    it('returns zero-score and a full suggestion list for empty input', () => {
        const r = computeKbQuality([]);
        expect(r.score).toBe(0);
        expect(r.breakdown.suggestions.length).toBeGreaterThan(0);
        expect(r.breakdown.factors.readme_present.value).toBe(false);
        expect(r.breakdown.factors.chunk_count.value).toBe(0);
    });

    it('detects README.md presence at root', () => {
        const r = computeKbQuality([
            chunk({ filePath: 'README.md', content: 'X'.repeat(1000) }),
        ]);
        expect(r.breakdown.factors.readme_present.value).toBe(true);
        expect(r.breakdown.factors.readme_present.score).toBe(1);
    });

    it('detects README.mdx in a sub-directory', () => {
        const r = computeKbQuality([
            chunk({ filePath: 'apps/api/README.mdx', content: 'X'.repeat(1000) }),
        ]);
        expect(r.breakdown.factors.readme_present.value).toBe(true);
    });

    it('does not count _commits as a top-level diversity tag', () => {
        const chunks: RawChunk[] = [
            chunk({ filePath: '_commits/2026-W16.commit_history', content: 'X'.repeat(1000), tags: ['_commits', 'commit_history'], fileType: 'commit_history' }),
            chunk({ filePath: 'docs/x.md', content: 'X'.repeat(1000), tags: ['docs'] }),
        ];
        const r = computeKbQuality(chunks);
        expect(r.breakdown.factors.tag_diversity.value).toBe(1);  // only "docs"
    });

    it('counts commit_history weeks correctly and saturates at 10', () => {
        const chunks: RawChunk[] = [];
        for (let i = 0; i < 12; i++) {
            chunks.push(chunk({
                filePath: `_commits/2026-W${String(i + 1).padStart(2, '0')}.commit_history`,
                content:  'X'.repeat(1000),
                tags:     ['_commits', 'commit_history'],
                fileType: 'commit_history',
            }));
        }
        const r = computeKbQuality(chunks);
        expect(r.breakdown.factors.commit_evidence.value).toBe(12);
        expect(r.breakdown.factors.commit_evidence.score).toBe(1);  // saturated
    });

    it('aggregates distinct skills across all chunks for skill_coverage', () => {
        const chunks: RawChunk[] = [
            chunk({ filePath: 'a.md', content: 'x'.repeat(1000), skills: ['kubernetes networking', 'iac'] }),
            chunk({ filePath: 'b.md', content: 'x'.repeat(1000), skills: ['kubernetes networking', 'cdk'] }),
            chunk({ filePath: 'c.md', content: 'x'.repeat(1000), skills: ['observability'] }),
        ];
        const r = computeKbQuality(chunks);
        expect(r.breakdown.factors.skill_coverage.value).toBe(4);  // distinct
    });

    it('penalises very short and very long chunks via avg_chunk_length', () => {
        const tiny  = computeKbQuality([chunk({ filePath: 'a.md', content: 'X'.repeat(100) })]);
        const ideal = computeKbQuality([chunk({ filePath: 'a.md', content: 'X'.repeat(1100) })]);
        const huge  = computeKbQuality([chunk({ filePath: 'a.md', content: 'X'.repeat(3500) })]);
        expect(tiny.breakdown.factors.avg_chunk_length.score).toBeLessThan(ideal.breakdown.factors.avg_chunk_length.score);
        expect(huge.breakdown.factors.avg_chunk_length.score).toBeLessThan(ideal.breakdown.factors.avg_chunk_length.score);
        expect(ideal.breakdown.factors.avg_chunk_length.score).toBe(1);
    });

    it('produces a final score that equals the sum of weighted contributions', () => {
        const chunks: RawChunk[] = [
            chunk({ filePath: 'README.md', content: 'X'.repeat(1100), tags: ['root'], skills: ['s1'] }),
            chunk({ filePath: 'docs/a.md', content: 'X'.repeat(1100), tags: ['docs'], skills: ['s2', 's3'] }),
        ];
        const r = computeKbQuality(chunks);
        const sum = Object.values(r.breakdown.factors)
            .reduce((acc, f) => acc + f.weighted, 0);
        // Allow 0.02 slack for the cumulative round2 across 6 factors.
        expect(Math.abs(r.score - Math.round(sum * 100) / 100)).toBeLessThanOrEqual(0.02);
    });

    it('weights sum to exactly 1.0', () => {
        const r = computeKbQuality([chunk({ filePath: 'a.md', content: 'X'.repeat(1000) })]);
        const total = Object.values(r.breakdown.factors)
            .reduce((acc, f) => acc + f.weight, 0);
        expect(total).toBeCloseTo(1, 10);
    });

    it('emits actionable suggestions for sparse inputs', () => {
        const r = computeKbQuality([
            chunk({ filePath: 'src/x.ts', content: 'X'.repeat(50) }),
        ]);
        const text = r.breakdown.suggestions.join('\n');
        expect(text).toMatch(/README/);
        expect(text).toMatch(/[Cc]ommit history/);
    });

    it('rounds final score to 2 decimals', () => {
        const r = computeKbQuality([
            chunk({ filePath: 'README.md', content: 'X'.repeat(1000), skills: ['a','b','c','d','e'] }),
        ]);
        expect(Number(r.score.toFixed(2))).toBe(r.score);
    });
});
