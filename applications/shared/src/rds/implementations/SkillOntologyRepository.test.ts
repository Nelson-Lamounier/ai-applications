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

    describe('loadRepoConcepts', () => {
        it('maps rows to RepoConceptRow, lowercasing canonicalName', async () => {
            const repo = new SkillOntologyRepository(fakePool([
                { canonical_name: 'Observability', repo_full_name: 'org/repo-a', detector: 'grafana-config', files: 11 },
            ]));
            const rows = await repo.loadRepoConcepts('user-1');
            expect(rows).toEqual([
                { canonicalName: 'observability', repoFullName: 'org/repo-a', detector: 'grafana-config', files: 11 },
            ]);
        });

        it('queries concept_evidence joined to skill_ontology, filtered by user_id, grouped by canonical/repo/detector', async () => {
            const pool = fakePool([]);
            const repo = new SkillOntologyRepository(pool);
            await repo.loadRepoConcepts('user-1');
            const mockQuery = (pool as unknown as { query: jest.Mock }).query;
            const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
            expect(sql).toContain('FROM concept_evidence ce');
            expect(sql).toContain('JOIN skill_ontology so ON so.id = ce.skill_id');
            expect(sql).toContain('WHERE ce.user_id = $1');
            expect(sql).toContain('GROUP BY 1, 2, 3');
            expect(params).toEqual(['user-1']);
        });

        it('returns an empty array when the user has no concept evidence', async () => {
            const repo = new SkillOntologyRepository(fakePool([]));
            expect(await repo.loadRepoConcepts('user-1')).toEqual([]);
        });
    });
});
