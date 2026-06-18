/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { SkillOntologyRepository } from './SkillOntologyRepository.js';
import { OntologyResolver } from '../ontology/OntologyResolver.js';

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
