/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { SkillOntologyRepository } from './SkillOntologyRepository.js';
import { OntologyResolver } from '../ontology/OntologyResolver.js';

function poolWith(rows: Array<{ canonical_name: string; embedding: string | null }>) {
    const query = jest.fn<(sql: string, params?: unknown[]) => Promise<{ rows: typeof rows }>>().mockResolvedValue({ rows });
    return { pool: { query } as never, query };
}

function fakePool(rows: unknown[]) {
    return { query: jest.fn(async () => ({ rows })) } as never;
}

describe('SkillOntologyRepository', () => {
    it('loadAliasMap builds an alias -> skill_id map', async () => {
        const repo = new SkillOntologyRepository(fakePool([
            { alias: 'k8s networking', skill_id: 'sk-1' },
            { alias: 'kubernetes networking', skill_id: 'sk-1' },
        ]));
        const map = await repo.loadAliasMap();
        expect(map.get('k8s networking')).toBe('sk-1');
        expect(map.get('kubernetes networking')).toBe('sk-1');
    });

    it('loadAliasToCanonicalMap lowercases alias and canonical', async () => {
        const repo = new SkillOntologyRepository(fakePool([
            { alias: 'IaC', canonical_name: 'Infrastructure As Code' },
        ]));
        const map = await repo.loadAliasToCanonicalMap();
        expect(map.get('iac')).toBe('infrastructure as code');
    });

    it('feeds the generic OntologyResolver: a raw skill variant resolves to one canonical id', async () => {
        const repo = new SkillOntologyRepository(fakePool([
            { alias: 'k8s networking', skill_id: 'sk-1' },
            { alias: 'kubernetes networking', skill_id: 'sk-1' },
        ]));
        const resolver = new OntologyResolver(await repo.loadAliasMap());
        expect(resolver.resolve('K8s Networking')).toBe('sk-1'); // normalizeAlias lowercases
        expect(resolver.resolve('unknown skill')).toBeNull();
    });
});

describe('SkillOntologyRepository.loadSkillVectors', () => {
    it('returns an empty map for no names without querying', async () => {
        const { pool, query } = poolWith([]);
        const repo = new SkillOntologyRepository(pool);
        const out = await repo.loadSkillVectors([]);
        expect(out.size).toBe(0);
        expect(query).not.toHaveBeenCalled();
    });

    it('maps canonical_name -> parsed vector and skips NULL/garbage', async () => {
        const { pool, query } = poolWith([
            { canonical_name: 'aws auto scaling', embedding: '[0.1,0.2]' },
            { canonical_name: 'kubernetes', embedding: null },
        ]);
        const repo = new SkillOntologyRepository(pool);
        const out = await repo.loadSkillVectors(['aws auto scaling', 'kubernetes']);
        expect(out.get('aws auto scaling')).toEqual([0.1, 0.2]);
        expect(out.has('kubernetes')).toBe(false);
        // queries with the names array bound to $1 and embedding cast to text
        const sql = String(query.mock.calls[0][0]);
        expect(sql).toMatch(/canonical_name = ANY\(\$1\)/);
        expect(sql).toMatch(/embedding::text/);
    });
});
