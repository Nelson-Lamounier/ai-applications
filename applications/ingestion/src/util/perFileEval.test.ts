/**
 * @format
 * Unit tests for buildPerFileCandidate (perFileEval.ts).
 *
 * Uses a stub enricher (no Bedrock) to exercise the group → call → fan-back
 * logic. Verifies that the resulting SkillsByChunk matches the surface-match
 * expectation and that computeEnrichEvalMetrics correctly reports recall = 1
 * when the candidate is identical to the baseline, and recall < 1 when the
 * candidate drops a baseline skill.
 */

import type { RawChunk } from '@bedrock/shared';
import { computeEnrichEvalMetrics } from './enrichEvalMetrics.js';
import { buildPerFileCandidate } from './perFileEval.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a minimal RawChunk. */
function chunk(filePath: string, chunkIndex: number, content: string, heading?: string): RawChunk {
    return { filePath, chunkIndex, content, heading, totalChunks: 3 };
}

/** A stub enricher that returns a fixed skill set regardless of content. */
function stubEnricher(skills: string[]) {
    return {
        enrich: async (_c: RawChunk) => ({ skills, technologies: [] }),
        enrichText: async (_fp: string, _content: string, _heading?: string) => ({ skills, technologies: [] }),
    };
}

/**
 * A stub enricher whose skills depend on which file is being enriched —
 * so we can simulate a candidate that drops a skill relative to the baseline.
 */
function stubEnricherByFile(skillsByFilePath: Record<string, string[]>) {
    return {
        enrich: async (c: RawChunk) => ({ skills: skillsByFilePath[c.filePath] ?? [], technologies: [] }),
        enrichText: async (fp: string, _content: string, _heading?: string) => ({
            skills: skillsByFilePath[fp] ?? [],
            technologies: [],
        }),
    };
}

// ---------------------------------------------------------------------------
// 2-file / 3-chunk fixture
// ---------------------------------------------------------------------------
//
// file-a.ts  has chunks 0 + 1
//   chunk 0: mentions "kubernetes networking"
//   chunk 1: mentions "react development"
// file-b.ts  has chunk 2
//   chunk 2: mentions "terraform"
//
// The stub enricher emits both skills for every file call; assignSkillsToChunks
// then fans back only the skills that surface-match the individual chunk.

const CHUNKS: RawChunk[] = [
    chunk('file-a.ts', 0, 'sets up kubernetes networking with calico'),
    chunk('file-a.ts', 1, 'renders a react development component'),
    chunk('file-b.ts', 2, 'terraform plan and apply'),
];

const MULTI_SKILL_ENRICHER = stubEnricher(['kubernetes networking', 'react development', 'terraform']);

describe('buildPerFileCandidate', () => {
    it('fan-back: assigns skills only to the chunk whose content surface-matches', async () => {
        const { candidate } = await buildPerFileCandidate(CHUNKS, MULTI_SKILL_ENRICHER, { maxChars: 20_000 });

        // chunk 0 evidences "kubernetes networking" — NOT "react development" or "terraform"
        expect(candidate.get('file-a.ts::0')).toEqual(expect.arrayContaining(['kubernetes networking']));
        expect(candidate.get('file-a.ts::0')).not.toContain('react development');
        expect(candidate.get('file-a.ts::0')).not.toContain('terraform');

        // chunk 1 evidences "react development" — NOT "kubernetes networking" or "terraform"
        expect(candidate.get('file-a.ts::1')).toEqual(expect.arrayContaining(['react development']));
        expect(candidate.get('file-a.ts::1')).not.toContain('kubernetes networking');

        // chunk 2 evidences "terraform" only
        expect(candidate.get('file-b.ts::2')).toEqual(expect.arrayContaining(['terraform']));
        expect(candidate.get('file-b.ts::2')).not.toContain('kubernetes networking');
    });

    it('all three chunks appear in the candidate map', async () => {
        const { candidate } = await buildPerFileCandidate(CHUNKS, MULTI_SKILL_ENRICHER, { maxChars: 20_000 });
        expect(candidate.size).toBe(3);
    });

    it('callCount equals the number of FileEnrichUnits (one per file when under budget)', async () => {
        const { callCount } = await buildPerFileCandidate(CHUNKS, MULTI_SKILL_ENRICHER, { maxChars: 20_000 });
        // Two distinct files → two model calls.
        expect(callCount).toBe(2);
    });

    it('callCount exceeds file count when a file is split by maxChars', async () => {
        // Force a very small budget so each chunk becomes its own unit.
        const { callCount } = await buildPerFileCandidate(CHUNKS, MULTI_SKILL_ENRICHER, { maxChars: 1 });
        // Three chunks → three units regardless of file grouping.
        expect(callCount).toBe(3);
    });

    // -------------------------------------------------------------------------
    // enrichEvalMetrics integration
    // -------------------------------------------------------------------------

    it('recall === 1 when candidate matches the baseline exactly (parity)', async () => {
        // Build a baseline where each chunk carries exactly the skills the stub will assign.
        const baseline = new Map<string, string[]>([
            ['file-a.ts::0', ['kubernetes networking']],
            ['file-a.ts::1', ['react development']],
            ['file-b.ts::2', ['terraform']],
        ]);
        const { candidate } = await buildPerFileCandidate(CHUNKS, MULTI_SKILL_ENRICHER, { maxChars: 20_000 });
        const result = computeEnrichEvalMetrics(baseline, candidate);
        expect(result.recall).toBe(1);
    });

    it('recall < 1 when candidate drops a baseline skill', async () => {
        // Baseline expects "kubernetes networking" on chunk 0.
        // The enricher for file-a.ts deliberately omits "kubernetes networking",
        // so the candidate for chunk 0 will be empty → recall drops.
        const baseline = new Map<string, string[]>([
            ['file-a.ts::0', ['kubernetes networking']],
            ['file-a.ts::1', ['react development']],
            ['file-b.ts::2', ['terraform']],
        ]);

        // file-a.ts enricher returns only "react development" (missing "kubernetes networking")
        const dropEnricher = stubEnricherByFile({
            'file-a.ts': ['react development'],
            'file-b.ts': ['terraform'],
        });

        const { candidate } = await buildPerFileCandidate(CHUNKS, dropEnricher, { maxChars: 20_000 });
        const result = computeEnrichEvalMetrics(baseline, candidate);
        // chunk 0 misses "kubernetes networking" → recall < 1
        expect(result.recall).toBeLessThan(1);
        expect(result.droppedSkills).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// Threshold sweep helpers (Task 4)
// ---------------------------------------------------------------------------

import { enrichUnitsOnce, fanbackCandidate } from './perFileEval.js';

describe('threshold sweep helpers', () => {
    const chunks = [
        { filePath: 'a.tf', content: 'scaling group desired 3', chunkIndex: 0, totalChunks: 2 },
        { filePath: 'a.tf', content: 'unrelated', chunkIndex: 1, totalChunks: 2 },
    ];
    // canonical enricher returns one skill not present verbatim in either chunk
    const enricher = { modelId: 'stub', enrichTextCanonical: async () => ({ canonical: ['aws auto scaling'], newSkills: [] }) } as never;

    it('enriches each unit once and reports callCount', async () => {
        const { units, callCount } = await enrichUnitsOnce(chunks, enricher, { vocab: ['aws auto scaling'] });
        expect(callCount).toBe(1);
        expect(units[0].skills).toEqual(['aws auto scaling']);
    });

    it('fanbackCandidate recovers the skill above threshold and drops it below', async () => {
        const { units } = await enrichUnitsOnce(chunks, enricher, { vocab: ['aws auto scaling'] });
        const idMap = new Map([['a.tf::0', 'id0'], ['a.tf::1', 'id1']]);
        const skillVectors = new Map<string, readonly number[]>([['aws auto scaling', [1, 0]]]);
        const vecAbove = (_f: string, i: number) => (i === 0 ? [1, 0] : [0, 1]);
        const above = fanbackCandidate(units, idMap, { skillVectors, chunkVectorOf: vecAbove, threshold: 0.8 });
        expect(above.get('id0')).toEqual(['aws auto scaling']);
        expect(above.get('id1')).toEqual([]);
        const below = fanbackCandidate(units, idMap, { skillVectors, chunkVectorOf: vecAbove, threshold: 0.99 });
        // cosine([1,0],[1,0])=1 >= 0.99 still passes; use an orthogonal-ish vector to prove the drop
        const vecLow = (_f: string, _i: number) => [0.7, 0.7];
        const dropped = fanbackCandidate(units, idMap, { skillVectors, chunkVectorOf: vecLow, threshold: 0.99 });
        expect(dropped.get('id0')).toEqual([]);
        expect(below.get('id0')).toEqual(['aws auto scaling']);
    });

    it('fanbackCandidate with null evidence is surface-match only', async () => {
        const { units } = await enrichUnitsOnce(chunks, enricher, { vocab: ['aws auto scaling'] });
        const idMap = new Map([['a.tf::0', 'id0'], ['a.tf::1', 'id1']]);
        const out = fanbackCandidate(units, idMap, null);
        expect(out.get('id0')).toEqual([]); // no surface match, no vectors
    });
});
