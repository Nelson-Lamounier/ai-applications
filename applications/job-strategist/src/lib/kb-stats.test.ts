/** @format */
import { computeKbStats } from './kb-stats.js';

const SEP = '\n\n---\n\n';

function ctx(...passages: string[]): string {
    return passages.join(SEP);
}

describe('computeKbStats', () => {
    it('parses the Cosine/Rerank header and aggregates scores', () => {
        const kb = ctx(
            '[Source: o/repo-a/src/x.ts, Cosine: 0.310, Rerank: 0.015]\nbody a',
            '[Source: o/repo-a/README.md, Cosine: 0.250, Rerank: 0.012]\nbody b',
            '[Source: o/repo-b/infra/y.ts, Cosine: 0.200, Rerank: 0.014]\nbody c',
        );
        const s = computeKbStats(kb, 0.2);
        expect(s.passageCount).toBe(3);
        expect(s.maxCosine).toBeCloseTo(0.31);
        expect(s.minCosine).toBeCloseTo(0.2);
        expect(s.medianCosine).toBeCloseTo(0.25);
        expect(s.floor).toBe(0.2);
        expect(s.topSources[0]).toEqual({ source: 'o/repo-a/src/x.ts', cosine: 0.31 });
        expect(s.repoBreakdown).toEqual([
            { repo: 'o/repo-a', count: 2 },
            { repo: 'o/repo-b', count: 1 },
        ]);
    });

    it('treats a legacy Score header as the cosine', () => {
        const s = computeKbStats('[Source: o/r/a.ts, Score: 0.42]\nbody', 0.2);
        expect(s.passageCount).toBe(1);
        expect(s.maxCosine).toBeCloseTo(0.42);
    });

    it('returns an empty snapshot for blank context (nothing cleared the floor)', () => {
        const s = computeKbStats('', 0.2);
        expect(s).toEqual({
            passageCount: 0, maxCosine: 0, medianCosine: 0, minCosine: 0,
            floor: 0.2, topSources: [], repoBreakdown: [],
        });
    });

    it('caps topSources at 5, descending by cosine', () => {
        const kb = ctx(...Array.from({ length: 8 }, (_, i) =>
            `[Source: o/r/f${i}.ts, Cosine: 0.${20 + i}0, Rerank: 0.01]\nb`));
        const s = computeKbStats(kb, 0.2);
        expect(s.topSources).toHaveLength(5);
        expect(s.topSources[0].cosine).toBeCloseTo(0.27);
        expect(s.topSources[4].cosine).toBeCloseTo(0.23);
    });
});
