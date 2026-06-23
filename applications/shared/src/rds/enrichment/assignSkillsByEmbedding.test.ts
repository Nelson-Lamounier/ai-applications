/** @format */
import { describe, it, expect } from '@jest/globals';
import { assignSkillsByEmbedding, cosineSimilarity, parseVector } from './assignSkillsByEmbedding.js';
import type { FileEnrichUnit } from './groupChunksByFile.js';

const unit: FileEnrichUnit = {
    filePath: 'svc/pods.yaml',
    text: 'irrelevant — text not used by the fan-back',
    chunks: [
        { filePath: 'svc/pods.yaml', content: 'horizontalpodautoscaler maxReplicas 10', chunkIndex: 0, totalChunks: 2 },
        { filePath: 'svc/pods.yaml', content: 'plain prose with no skill terms', chunkIndex: 1, totalChunks: 2 },
    ],
};

describe('cosineSimilarity', () => {
    it('is 1 for identical vectors and 0 for orthogonal', () => {
        expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
        expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    });
    it('returns 0 on empty or mismatched-length input', () => {
        expect(cosineSimilarity([], [1])).toBe(0);
        expect(cosineSimilarity([1, 2], [1])).toBe(0);
    });
});

describe('parseVector', () => {
    it('parses a pgvector text value', () => {
        expect(parseVector('[0.1,0.2,0.3]')).toEqual([0.1, 0.2, 0.3]);
    });
    it('passes through arrays and rejects null/garbage', () => {
        expect(parseVector([1, 2])).toEqual([1, 2]);
        expect(parseVector(null)).toBeNull();
        expect(parseVector('')).toBeNull();
        expect(parseVector('not-json')).toBeNull();
    });
});

describe('assignSkillsByEmbedding', () => {
    const skill = 'kubernetes autoscaling';
    // chunk 0 vector aligns with the skill vector; chunk 1 is orthogonal.
    const skillVectors = new Map<string, readonly number[]>([[skill, [1, 0]]]);

    it('keeps a skill on a chunk by surface-match even with no/poor vector', () => {
        const chunkVectors = new Map<number, readonly number[]>([[0, [0, 1]], [1, [0, 1]]]);
        // 'horizontalpodautoscaler' does not contain 'kubernetes autoscaling' — no surface match;
        // use a surface-matching skill to prove the OR branch.
        const out = assignSkillsByEmbedding(unit, ['maxReplicas'], { skillVectors: new Map(), chunkVectors, threshold: 0.9 });
        expect(out[0].skills).toEqual(['maxReplicas']); // surface-matches chunk 0 content
        expect(out[1].skills).toEqual([]);
    });

    it('recovers a non-surface-matching skill when its vector is close to the chunk vector', () => {
        const chunkVectors = new Map<number, readonly number[]>([[0, [1, 0]], [1, [0, 1]]]);
        const out = assignSkillsByEmbedding(unit, [skill], { skillVectors, chunkVectors, threshold: 0.8 });
        expect(out[0].skills).toEqual([skill]); // cosine([1,0],[1,0])=1 >= 0.8
        expect(out[1].skills).toEqual([]);      // cosine([1,0],[0,1])=0 < 0.8
    });

    it('drops a skill below threshold', () => {
        const chunkVectors = new Map<number, readonly number[]>([[0, [0.7, 0.7]], [1, [0, 1]]]);
        const out = assignSkillsByEmbedding(unit, [skill], { skillVectors, chunkVectors, threshold: 0.95 });
        expect(out[0].skills).toEqual([]); // cosine ~0.707 < 0.95
    });

    it('falls back to surface-only when a skill vector is missing', () => {
        const chunkVectors = new Map<number, readonly number[]>([[0, [1, 0]], [1, [1, 0]]]);
        const out = assignSkillsByEmbedding(unit, [skill], { skillVectors: new Map(), chunkVectors, threshold: 0.1 });
        expect(out[0].skills).toEqual([]); // no vector, no surface match
    });

    it('falls back to surface-only when a chunk vector is missing', () => {
        const out = assignSkillsByEmbedding(unit, [skill], { skillVectors, chunkVectors: new Map(), threshold: 0.1 });
        expect(out[0].skills).toEqual([]); // chunk 0 has no vector -> embedding lane skipped
    });
});
