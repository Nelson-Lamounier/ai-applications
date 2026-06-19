/** @format */
import { describe, it, expect } from '@jest/globals';
import { dedupeSkillCanonicals, type DedupCandidate } from './dedupeSkillCanonicals.js';

const c = (id: string, canonical: string, embedding: number[], curationLevel = 'auto_imported'): DedupCandidate =>
    ({ id, canonical, embedding, curationLevel });

// Orthogonal unit vectors → cosine 0; identical → 1; scaled copies → 1.
const X = [1, 0, 0];
const Y = [0, 1, 0];

describe('dedupeSkillCanonicals', () => {
    it('auto-merges a near-identical pair (cosine >= autoMerge)', () => {
        const actions = dedupeSkillCanonicals(
            [c('a', 'cross-functional collaboration', [1, 0.02, 0]), c('b', 'cross-functional partnership', [1, 0, 0])],
            { autoMergeThreshold: 0.85, reviewFloor: 0.70 },
        );
        expect(actions).toHaveLength(1);
        expect(actions[0].kind).toBe('merge');
        expect(actions[0].similarity).toBeGreaterThanOrEqual(0.85);
    });

    it('routes a grey-band pair to review ([reviewFloor, autoMerge))', () => {
        // cosine ~0.78 — between 0.70 and 0.85
        const actions = dedupeSkillCanonicals(
            [c('a', 'user empathy', [1, 0.8, 0]), c('b', 'customer empathy', [1, 0, 0])],
            { autoMergeThreshold: 0.85, reviewFloor: 0.70 },
        );
        expect(actions).toHaveLength(1);
        expect(actions[0].kind).toBe('review');
    });

    it('leaves clearly distinct skills alone (cosine < reviewFloor)', () => {
        expect(dedupeSkillCanonicals(
            [c('a', 'kubernetes networking', X), c('b', 'rest api design', Y)],
            { autoMergeThreshold: 0.85, reviewFloor: 0.70 },
        )).toEqual([]);
    });

    it('keeps the curated row when merging a curated/auto pair', () => {
        const actions = dedupeSkillCanonicals(
            [c('auto', 'data-driven decisions', [1, 0.05, 0], 'auto_imported'),
             c('cur', 'data-driven', [1, 0, 0], 'curated')],
            { autoMergeThreshold: 0.85, reviewFloor: 0.70 },
        );
        expect(actions[0]).toMatchObject({ kind: 'merge', keepId: 'cur', dropId: 'auto' });
    });

    it('ignores entries without an embedding and is deterministic', () => {
        const actions = dedupeSkillCanonicals(
            [c('a', 'x', []), c('b', 'y', [1, 0, 0]), c('cc', 'z', [1, 0, 0])],
            { autoMergeThreshold: 0.85, reviewFloor: 0.70 },
        );
        // only b<->cc compared (a has no embedding); identical → merge, keep 'b' (first)
        expect(actions).toEqual([{ kind: 'merge', keepId: 'b', dropId: 'cc', similarity: 1 }]);
    });
});
