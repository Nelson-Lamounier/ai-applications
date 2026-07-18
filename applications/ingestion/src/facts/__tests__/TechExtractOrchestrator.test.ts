/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { TechExtractOrchestrator } from '../TechExtractOrchestrator.js';
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
            userId: 'u1', repoFullName: 'o/r', commitSha: 'abc', rootDir: '/tmp/extract', ontologyVersion: 3, extractors: [good, bad], githubRepoId: 999,
        });

        const persisted = (evidenceRepo.insertMany as jest.Mock).mock.calls[0][1] as { technologyId: string | null; rawName: string }[];
        expect(persisted.find(r => r.rawName === 'React')!.technologyId).toBe('id-react');
        expect(persisted.find(r => r.rawName === 'mystery')!.technologyId).toBeNull();
        expect(candidateRepo.upsert).toHaveBeenCalledTimes(1);
        expect(result.failedExtractors).toEqual(['bad']);
        expect(result.matched).toBe(1);
        expect(result.unmatched).toBe(1);
        expect(result.canonicalIds.has('id-react')).toBe(true);
        expect(good.extract).toHaveBeenCalledWith('/tmp/extract');
    });

    it('returns the resolved evidence rows alongside the summary counts', async () => {
        const evidenceRepo = { insertMany: jest.fn(async () => {}) };
        const candidateRepo = { upsert: jest.fn(async () => {}) };
        const good = fakeExtractor('good', [
            { raw_name: 'React', ecosystem: 'npm', source_layer: 'syft', file_path: 'package.json' },
        ]);

        const orch = new TechExtractOrchestrator(resolver, evidenceRepo as never, candidateRepo as never);
        const result = await orch.run({
            userId: 'u1', repoFullName: 'o/r', commitSha: 'abc', rootDir: '/tmp/extract', ontologyVersion: 3, extractors: [good], githubRepoId: 999,
        });

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({ technologyId: 'id-react', rawName: 'React', sourceLayer: 'syft', filePath: 'package.json' });
    });

    it('dryRun: skips candidateRepo.upsert and evidenceRepo.insertMany but still resolves rows', async () => {
        const evidenceRepo = { insertMany: jest.fn(async () => {}) };
        const candidateRepo = { upsert: jest.fn(async () => {}) };
        const good = fakeExtractor('good', [
            { raw_name: 'React', ecosystem: 'npm', source_layer: 'syft', file_path: 'package.json' },
            { raw_name: 'mystery', ecosystem: 'npm', source_layer: 'syft', file_path: 'package.json' },
        ]);

        const orch = new TechExtractOrchestrator(resolver, evidenceRepo as never, candidateRepo as never);
        const result = await orch.run({
            userId: 'u1', repoFullName: 'o/r', commitSha: 'abc', rootDir: '/tmp/extract', ontologyVersion: 3,
            extractors: [good], githubRepoId: 999, dryRun: true,
        });

        expect(evidenceRepo.insertMany).not.toHaveBeenCalled();
        expect(candidateRepo.upsert).not.toHaveBeenCalled();
        expect(result.matched).toBe(1);
        expect(result.unmatched).toBe(1);
        expect(result.canonicalIds.has('id-react')).toBe(true);
        expect(result.rows).toHaveLength(2);
        expect(result.rows.find(r => r.rawName === 'React')!.technologyId).toBe('id-react');
        expect(result.rows.find(r => r.rawName === 'mystery')!.technologyId).toBeNull();
    });
});
