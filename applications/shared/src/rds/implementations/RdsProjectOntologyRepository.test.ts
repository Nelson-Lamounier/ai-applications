import { describe, it, expect, jest } from '@jest/globals';
import { RdsProjectOntologyRepository } from './RdsProjectOntologyRepository.js';

function fakePool(rowsBySql: Array<{ match: RegExp; rows: unknown[] }>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = jest.fn(async (sql: string) => {
        const hit = rowsBySql.find(r => r.match.test(sql));
        return { rows: hit ? hit.rows : [] };
    });
    return { pool: { query } as any, query };
}

describe('RdsProjectOntologyRepository', () => {
    it('getArchetype maps a row to ArchetypeDef', async () => {
        const { pool } = fakePool([{ match: /FROM project_archetypes/, rows: [{
            id: 'production_saas', name: 'Production SaaS Application', description: 'd',
            classification_signals: { required_any: ['has_iac'], positive: ['has_ci'], negative: [] },
            expected_sections: ['architecture'], expected_artifacts: ['adrs'],
        }] }]);
        const repo = new RdsProjectOntologyRepository(pool);
        const a = await repo.getArchetype('production_saas');
        expect(a?.id).toBe('production_saas');
        expect(a?.classificationSignals.required_any).toEqual(['has_iac']);
        expect(a?.expectedSections).toEqual(['architecture']);
    });
    it('getArchetype returns null when no row', async () => {
        const { pool } = fakePool([{ match: /FROM project_archetypes/, rows: [] }]);
        expect(await new RdsProjectOntologyRepository(pool).getArchetype('nope')).toBeNull();
    });
    it('listArchetypes returns all rows mapped', async () => {
        const { pool } = fakePool([{ match: /FROM project_archetypes/, rows: [
            { id: 'a', name: 'A', description: 'd', classification_signals: {}, expected_sections: [], expected_artifacts: [] },
            { id: 'b', name: 'B', description: 'd', classification_signals: {}, expected_sections: [], expected_artifacts: [] },
        ] }]);
        const all = await new RdsProjectOntologyRepository(pool).listArchetypes();
        expect(all.map(a => a.id)).toEqual(['a', 'b']);
    });
    it('getStageOverlay maps a row, returns null when absent', async () => {
        const { pool } = fakePool([{ match: /FROM project_stage_overlays/, rows: [{
            archetype_id: 'production_saas', stage: 'senior',
            priority_sections: ['architecture','deployment'], deemphasized_sections: [],
            stage_suggestions: [{ id: 'x', pillar: 'p', title: 'T', description: 'D', trigger: 'any', impact: 0.9, effort: 0.3 }],
        }] }]);
        const repo = new RdsProjectOntologyRepository(pool);
        const o = await repo.getStageOverlay('production_saas', 'senior');
        expect(o?.prioritySections).toEqual(['architecture','deployment']);
        expect(o?.stageSuggestions[0]).toEqual({ title: 'T', description: 'D' });
        const { pool: empty } = fakePool([{ match: /FROM project_stage_overlays/, rows: [] }]);
        expect(await new RdsProjectOntologyRepository(empty).getStageOverlay('x', 'junior')).toBeNull();
    });
});
