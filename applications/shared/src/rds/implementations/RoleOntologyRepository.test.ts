/** @format */
import type { Pool } from 'pg';
import { RoleOntologyRepository } from './RoleOntologyRepository.js';

function mockPool(handlers: Array<(sql: string, params?: unknown[]) => { rows: unknown[] }>) {
    let i = 0;
    const query = jest.fn((sql: string, params?: unknown[]) => Promise.resolve(handlers[i++]?.(sql, params) ?? { rows: [] }));
    return { pool: { query } as unknown as Pool, query };
}

describe('RoleOntologyRepository', () => {
    it('loadAliasMap builds a lowercase alias→family map', async () => {
        const { pool } = mockPool([() => ({ rows: [{ alias: 'support engineer', family_key: 'technical-support' }] })]);
        const map = await new RoleOntologyRepository(pool).loadAliasMap();
        expect(map.get('support engineer')).toBe('technical-support');
    });

    it('loadFamilies returns curated+auto_imported only (excludes candidate), mapped to camelCase', async () => {
        const { pool, query } = mockPool([() => ({ rows: [{
            family_key: 'technical-support', display_name: 'Technical Support / Customer Engineering',
            role_class: 'customer_facing', canonical_responsibilities: ['Triage queues'],
            vocabulary: ['SLA'], transferable_skills: ['customer empathy'], industry_notes: 'note',
        }] })]);
        const fams = await new RoleOntologyRepository(pool).loadFamilies();
        expect(fams[0]).toMatchObject({ familyKey: 'technical-support', roleClass: 'customer_facing', vocabulary: ['SLA'] });
        expect((query.mock.calls[0][0] as string)).toMatch(/curation IN \('curated','auto_imported'\)/i);
    });

    it('stageCandidate upserts one vote per user (ON CONFLICT DO NOTHING)', async () => {
        const { pool, query } = mockPool([() => ({ rows: [] })]);
        await new RoleOntologyRepository(pool).stageCandidate({ familyKey: 'technical-support', candidateType: 'alias', value: 'tech support rep', contributingUserId: 'u-1' });
        expect(query.mock.calls[0][0] as string).toMatch(/INSERT INTO role_learning_candidates/i);
        expect(query.mock.calls[0][0] as string).toMatch(/ON CONFLICT.*DO NOTHING/i);
        expect(query.mock.calls[0][1]).toEqual(['technical-support', 'alias', 'tech support rep', 'u-1']);
    });

    it('promote runs the two corroboration UPSERTs with the quorum', async () => {
        const { pool, query } = mockPool([() => ({ rows: [] }), () => ({ rows: [] })]);
        await new RoleOntologyRepository(pool).promote(3);
        const sqls = query.mock.calls.map((c) => c[0] as string).join('\n');
        expect(sqls).toMatch(/role_aliases/);
        expect(sqls).toMatch(/array_append|vocabulary/i);
        expect(query.mock.calls.every((c) => (c[1] as unknown[]).includes(3))).toBe(true);
    });
});
