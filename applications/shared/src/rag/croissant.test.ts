/** @format */
import { describe, it, expect } from '@jest/globals';
import { buildCroissant } from './croissant.js';

describe('buildCroissant', () => {
    it('emits a Croissant 1.0 dataset with the chunk record set', () => {
        const ds = buildCroissant({ repoFullName: 'owner/repo', recordCount: 12 });
        expect(ds['@type']).toBe('sc:Dataset');
        expect(ds.conformsTo).toBe('http://mlcommons.org/croissant/1.0');
        expect(ds.name).toBe('rag-kb-owner-repo');
        expect(ds.recordSet[0]?.name).toBe('chunks');
        const fieldNames = ds.recordSet[0]?.field.map(f => f.name);
        expect(fieldNames).toEqual(expect.arrayContaining([
            'file_path', 'line_start', 'line_end', 'commit_sha', 'content', 'skills', 'embedding',
        ]));
    });

    it('marks array-valued fields (skills, embedding) as repeated', () => {
        const ds = buildCroissant({ repoFullName: 'o/r', recordCount: 1 });
        const byName = Object.fromEntries((ds.recordSet[0]?.field ?? []).map(f => [f.name, f]));
        expect(byName['skills']?.repeated).toBe(true);
        expect(byName['embedding']?.repeated).toBe(true);
        expect(byName['file_path']?.repeated).toBeUndefined();
    });

    it('carries provenance + lineage into description, version, and keywords', () => {
        const ds = buildCroissant({
            repoFullName:    'o/r',
            recordCount:     200,
            commitSha:       'abc123',
            embeddingModel:  'amazon.titan-embed-text-v2:0',
            embeddingDim:    1024,
            enrichmentModel: 'haiku',
            skills:          ['kubernetes networking', 'gitops'],
        });
        expect(ds.version).toBe('abc123');
        expect(ds.keywords).toEqual(['kubernetes networking', 'gitops']);
        expect(ds.description).toContain('200 chunks');
        expect(ds.description).toContain('commit abc123');
        expect(ds.description).toContain('amazon.titan-embed-text-v2:0 (1024d)');
        expect(ds.description).toContain('enrichment haiku');
    });

    it('omits optional provenance cleanly when absent', () => {
        const ds = buildCroissant({ repoFullName: 'o/r', recordCount: 0 });
        expect(ds).not.toHaveProperty('version');
        expect(ds).not.toHaveProperty('keywords');
        expect(ds.description).toContain('0 chunks');
    });
});
