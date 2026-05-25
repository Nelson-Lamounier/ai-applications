/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { TechExtractOrchestrator } from './TechExtractOrchestrator.js';
import { OntologyResolver } from '@bedrock/shared';
import type { Extractor } from '../extractors/Extractor.js';

function fakeExtractor(name: string, rows: unknown[], throws = false): Extractor {
    return {
        name,
        extract: jest.fn(async () => { if (throws) throw new Error('boom'); return rows as never; }),
    };
}

describe('TechExtractOrchestrator.run', () => {
    const resolver = new OntologyResolver(new Map([['react', 'id-react']]));

    it('isolates a failing extractor and still persists the others', async () => {
        const evidenceRepo = { insertMany: jest.fn(async () => {}) };
        const candidateRepo = { upsert: jest.fn(async () => {}) };
        const good = fakeExtractor('good', [
            { raw_name: 'React', ecosystem: 'npm', source_layer: 'syft', file_path: 'package.json' },
            { raw_name: 'mystery', ecosystem: 'npm', source_layer: 'syft', file_path: 'package.json' },
        ]);
        const bad = fakeExtractor('bad', [], true);

        const orch = new TechExtractOrchestrator(resolver, evidenceRepo as never, candidateRepo as never);
        const result = await orch.run({
            userId: 'u1', repoFullName: 'o/r', commitSha: 'abc', ontologyVersion: 3, extractors: [good, bad],
        });

        const persisted = (evidenceRepo.insertMany as jest.Mock).mock.calls[0][1] as { technologyId: string | null; rawName: string }[];
        expect(persisted.find(r => r.rawName === 'React')!.technologyId).toBe('id-react');
        expect(persisted.find(r => r.rawName === 'mystery')!.technologyId).toBeNull();
        expect(candidateRepo.upsert).toHaveBeenCalledTimes(1);
        expect(result.failedExtractors).toEqual(['bad']);
        expect(result.matched).toBe(1);
        expect(result.unmatched).toBe(1);
        expect(result.canonicalIds.has('id-react')).toBe(true);
    });
});
