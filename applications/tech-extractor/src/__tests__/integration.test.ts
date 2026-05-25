/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { OntologyResolver } from '@bedrock/shared';
import { TechExtractOrchestrator } from '../orchestrator/TechExtractOrchestrator.js';
import { computeParity } from '../parity/ParityReporter.js';
import { parseDockerfile } from '../extractors/iac/DockerfileParser.js';
import type { Extractor } from '../extractors/Extractor.js';

describe('layer-1 end-to-end (in-process)', () => {
    it('extracts -> resolves -> reports parity', async () => {
        const resolver = new OntologyResolver(new Map([['node', 'id-node'], ['react', 'id-react']]));
        const dockerEx: Extractor = { name: 'iac', extract: async () => parseDockerfile('FROM node:22-alpine', 'Dockerfile') };
        const syftEx: Extractor = { name: 'syft', extract: async () => [{ raw_name: 'react', ecosystem: 'npm', source_layer: 'syft', file_path: 'package.json' }] };

        const evidenceRepo = { insertMany: jest.fn(async () => {}) };
        const candidateRepo = { upsert: jest.fn(async () => {}) };
        const orch = new TechExtractOrchestrator(resolver, evidenceRepo as never, candidateRepo as never);
        const result = await orch.run({ userId: 'u1', repoFullName: 'o/r', commitSha: 'abc', ontologyVersion: 1, extractors: [dockerEx, syftEx] });

        expect(result.matched).toBe(2);
        expect(result.canonicalIds.has('id-node')).toBe(true);

        const parity = computeParity(resolver, result.canonicalIds, ['react', 'node', 'kafka']);
        expect(parity.recall).toBeCloseTo(1.0);     // node + react both caught
        expect(parity.llmUnresolvableCount).toBe(1); // kafka not in this resolver
    });
});
