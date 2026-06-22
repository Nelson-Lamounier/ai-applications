/** @format */
import { describe, it, expect } from '@jest/globals';
import { gatherFreeEvidence } from './gather-evidence.js';
import type { JdSignal } from '@bedrock/shared';

const jd = {
    requiredSkills: ['AWS'],
    preferredSkills: [],
    tools: ['Kubernetes'],
    concepts: ['observability'],
    responsibilities: ['operate infra'],
    retrievalKeywords: ['aws', 'kubernetes'],
} as unknown as JdSignal;

// A fake pool that returns no project/tech/facts rows (thin portfolio).
const emptyPool = { query: async () => ({ rows: [] }) } as never;

describe('gatherFreeEvidence', () => {
    it('tolerates empty RAG and empty DB without throwing (thin portfolio)', async () => {
        const ev = await gatherFreeEvidence(emptyPool, { userId: 'u' } as never, jd, { retrieve: async () => [] });
        expect(ev.kbPassages).toEqual([]);
        expect(typeof ev.projectEvidence).toBe('string');
        expect(typeof ev.extractedTech).toBe('string');
    });

    it('collects RAG passages from the injected retriever across the JD-derived queries', async () => {
        const ev = await gatherFreeEvidence(emptyPool, { userId: 'u' } as never, jd, {
            retrieve: async (q: string) => [`[Source: me/app/x.ts]\nmatched: ${q.slice(0, 12)}`],
        });
        expect(ev.kbPassages.length).toBeGreaterThan(0);
        expect(ev.kbPassages[0]).toContain('[Source:');
    });
});
