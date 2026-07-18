import { describe, it, expect, jest } from '@jest/globals';
import { RdsUserProfileRollupRepository } from './RdsUserProfileRollupRepository.js';
import type { UserProfileRollupResult } from '../profile/computeUserProfileRollup.js';

function fakeClient(rows: unknown[]) {
    const calls: { sql: string; params: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params: params ?? [] });
            if (/SELECT[\s\S]*FROM repository_profiles/i.test(sql)) return { rows };
            return { rows: [] };
        }),
        release: jest.fn(),
    };
}
function fakePool(client: ReturnType<typeof fakeClient>) {
    return { connect: jest.fn(async () => client) } as never;
}

const sampleRollup: UserProfileRollupResult = {
    projectRepoCount: 2, totalRepoCount: 3, methodologyVersion: 1,
    rollup: { version: 1 } as never,
};

describe('RdsUserProfileRollupRepository.listProfilesForRollup', () => {
    it('sets RLS user then SELECTs all profile rows (no classification filter)', async () => {
        const client = fakeClient([{
            repoFullName: 'o/r', classification: 'project', isHidden: false,
            extractionStatus: 'completed', primaryLanguage: 'TypeScript',
            commitCount: 5, lastActiveAt: null, domain: 'infra',
            complexity: 'simple', roleInferred: 'creator', techStack: ['AWS'],
        }]);
        const repo = new RdsUserProfileRollupRepository(fakePool(client));
        const out = await repo.listProfilesForRollup('11111111-1111-1111-1111-111111111111');

        expect(client.calls.some(c => c.sql === 'SET LOCAL ROLE tucaken_app')).toBe(true);
        const cfg = client.calls.find(c => c.sql.includes('set_config'));
        expect(cfg).toBeDefined();
        expect(cfg!.params[0]).toBe('11111111-1111-1111-1111-111111111111');
        const sel = client.calls.find(c => /FROM repository_profiles/i.test(c.sql))!;
        expect(sel.sql).not.toMatch(/classification\s*=/i);
        expect(sel.sql).not.toMatch(/is_hidden\s*=/i);
        expect(sel.sql).toMatch(/WHERE\s+user_id\s*=\s*\$1/i);
        expect(out).toHaveLength(1);
        expect(out[0].techStack).toEqual(['AWS']);
        expect(client.release).toHaveBeenCalled();
    });
});

describe('RdsUserProfileRollupRepository.upsert', () => {
    it('sets RLS user then upserts ON CONFLICT (user_id) with JSON rollup', async () => {
        const client = fakeClient([]);
        const repo = new RdsUserProfileRollupRepository(fakePool(client));
        await repo.upsert('22222222-2222-2222-2222-222222222222', sampleRollup);

        expect(client.calls.some(c => c.sql === 'SET LOCAL ROLE tucaken_app')).toBe(true);
        const cfg = client.calls.find(c => c.sql.includes('set_config'))!;
        expect(cfg.params[0]).toBe('22222222-2222-2222-2222-222222222222');
        const up = client.calls.find(c => /INSERT INTO user_profile_rollup/i.test(c.sql))!;
        expect(up.sql).toMatch(/ON CONFLICT \(user_id\) DO UPDATE/i);
        expect(up.params).toContain(2);
        expect(up.params).toContain(3);
        expect(up.params.some(p => typeof p === 'string' && p.includes('"version":1'))).toBe(true);
        expect(client.release).toHaveBeenCalled();
    });
});

describe('RdsUserProfileRollupRepository mirror/reveal', () => {
    it('upsert writes mirror/reveal/synthesis_refreshed_at when provided', async () => {
        const client = fakeClient([]);
        const repo = new RdsUserProfileRollupRepository(fakePool(client));
        await repo.upsert('u1', sampleRollup,
            { paragraph: 'p'.repeat(130) },
            { reveals: [{ insight: 'i'.repeat(25), evidence: 'role distribution' }] });
        const up = client.calls.find(c => /INSERT INTO user_profile_rollup/i.test(c.sql))!;
        expect(up.sql).toMatch(/mirror/i);
        expect(up.sql).toMatch(/synthesis_refreshed_at/i);
        expect(up.params.some(p => typeof p === 'string' && p.includes('"paragraph"'))).toBe(true);
    });
    it('upsert preserves prior mirror/reveal when omitted (COALESCE, no synth ts bump)', async () => {
        const client = fakeClient([]);
        const repo = new RdsUserProfileRollupRepository(fakePool(client));
        await repo.upsert('u1', sampleRollup);
        const up = client.calls.find(c => /INSERT INTO user_profile_rollup/i.test(c.sql))!;
        expect(up.sql).toMatch(/mirror\s*=\s*COALESCE\(\s*EXCLUDED\.mirror\s*,\s*user_profile_rollup\.mirror\s*\)/i);
        expect(up.sql).toMatch(/synthesis_refreshed_at\s*=\s*COALESCE\(/i);
    });
    it('getRollup sets RLS user, selects the row, returns null when absent', async () => {
        const client = fakeClient([]);                          // SELECT returns rows:[]
        const repo = new RdsUserProfileRollupRepository(fakePool(client));
        const out = await repo.getRollup('11111111-1111-1111-1111-111111111111');
        expect(client.calls.some(c => c.sql === 'SET LOCAL ROLE tucaken_app')).toBe(true);
        const cfg = client.calls.find(c => c.sql.includes('set_config'))!;
        expect(cfg.params[0]).toBe('11111111-1111-1111-1111-111111111111');
        const sel = client.calls.find(c => /SELECT[\s\S]*FROM user_profile_rollup/i.test(c.sql))!;
        expect(sel.sql).toMatch(/mirror/i);
        expect(sel.sql).toMatch(/reveal/i);
        expect(out).toBeNull();
    });
});

describe('RdsUserProfileRollupRepository direction', () => {
    it('upsert writes direction when provided', async () => {
        const client = fakeClient([]);
        const repo = new RdsUserProfileRollupRepository(fakePool(client));
        await repo.upsert('u1', sampleRollup, undefined, undefined,
            { archetypes: [{ archetype: 'platform', fit: 'strong', rationale: 'domain mix' }], seniority: [], whatToDeepen: [] });
        const up = client.calls.find(c => /INSERT INTO user_profile_rollup/i.test(c.sql))!;
        expect(up.sql).toMatch(/direction/i);
        expect(up.params.some(p => typeof p === 'string' && p.includes('"archetype"'))).toBe(true);
        expect(up.params[7]).toBeInstanceOf(Date);
    });
    it('upsert preserves prior direction when omitted (COALESCE)', async () => {
        const client = fakeClient([]);
        const repo = new RdsUserProfileRollupRepository(fakePool(client));
        await repo.upsert('u1', sampleRollup);
        const up = client.calls.find(c => /INSERT INTO user_profile_rollup/i.test(c.sql))!;
        expect(up.sql).toMatch(/direction\s*=\s*COALESCE\(\s*EXCLUDED\.direction\s*,\s*user_profile_rollup\.direction\s*\)/i);
    });
    it('getRollup selects direction', async () => {
        const client = fakeClient([]);
        const repo = new RdsUserProfileRollupRepository(fakePool(client));
        await repo.getRollup('11111111-1111-1111-1111-111111111111');
        const sel = client.calls.find(c => /SELECT[\s\S]*FROM user_profile_rollup/i.test(c.sql))!;
        expect(sel.sql).toMatch(/direction/i);
    });
});

describe('RdsUserProfileRollupRepository reconciliation', () => {
    it('upsert writes reconciliation when provided', async () => {
        const client = fakeClient([]);
        const repo = new RdsUserProfileRollupRepository(fakePool(client));
        await repo.upsert('u1', sampleRollup, undefined, undefined, undefined,
            { unsupportedClaims: [{ claim: 'c', resumeRef: 'Acme', whyUnsupported: 'w' }], undersold: [] });
        const up = client.calls.find(c => /INSERT INTO user_profile_rollup/i.test(c.sql))!;
        expect(up.sql).toMatch(/reconciliation/i);
        expect(up.params.some(p => typeof p === 'string' && p.includes('"resumeRef"'))).toBe(true);
        expect(up.params[7]).toBeInstanceOf(Date);
    });
    it('upsert preserves prior reconciliation when omitted (COALESCE)', async () => {
        const client = fakeClient([]);
        const repo = new RdsUserProfileRollupRepository(fakePool(client));
        await repo.upsert('u1', sampleRollup);
        const up = client.calls.find(c => /INSERT INTO user_profile_rollup/i.test(c.sql))!;
        expect(up.sql).toMatch(/reconciliation\s*=\s*COALESCE\(\s*EXCLUDED\.reconciliation\s*,\s*user_profile_rollup\.reconciliation\s*\)/i);
    });
    it('getRollup selects reconciliation', async () => {
        const client = fakeClient([]);
        const repo = new RdsUserProfileRollupRepository(fakePool(client));
        await repo.getRollup('11111111-1111-1111-1111-111111111111');
        const sel = client.calls.find(c => /SELECT[\s\S]*FROM user_profile_rollup/i.test(c.sql))!;
        expect(sel.sql).toMatch(/reconciliation/i);
    });
});

describe('RdsUserProfileRollupRepository diagnostic', () => {
    it('upsert writes diagnostic when provided', async () => {
        const client = fakeClient([]);
        const repo = new RdsUserProfileRollupRepository(fakePool(client));
        await repo.upsert('u1', sampleRollup, undefined, undefined, undefined, undefined,
            {
                overall: 78,
                components: {
                    profileDepth:            { score: 80, blockers: [] },
                    ragDepth:                { score: 70, blockers: ['No project repos with high KB quality'] },
                    directionConfidence:     { score: 80, blockers: [] },
                    reconciliationAlignment: { score: 80, blockers: [] },
                    resumeCoverage:          { score: 80, blockers: [] },
                },
                methodology: { version: 1, weights: { profileDepth:20, ragDepth:20, directionConfidence:20, reconciliationAlignment:20, resumeCoverage:20 }, notes: 'v1' },
                explanation: 'You score 78 because…',
            });
        const up = client.calls.find(c => /INSERT INTO user_profile_rollup/i.test(c.sql))!;
        expect(up.sql).toMatch(/diagnostic/i);
        expect(up.params.some(p => typeof p === 'string' && p.includes('"overall"'))).toBe(true);
        expect(up.params[7]).toBeInstanceOf(Date);   // synthTs set when diagnostic provided
    });

    it('upsert preserves prior diagnostic when omitted (COALESCE)', async () => {
        const client = fakeClient([]);
        const repo = new RdsUserProfileRollupRepository(fakePool(client));
        await repo.upsert('u1', sampleRollup);
        const up = client.calls.find(c => /INSERT INTO user_profile_rollup/i.test(c.sql))!;
        expect(up.sql).toMatch(/diagnostic\s*=\s*COALESCE\(\s*EXCLUDED\.diagnostic\s*,\s*user_profile_rollup\.diagnostic\s*\)/i);
    });

    it('getRollup selects diagnostic', async () => {
        const client = fakeClient([]);
        const repo = new RdsUserProfileRollupRepository(fakePool(client));
        await repo.getRollup('11111111-1111-1111-1111-111111111111');
        const sel = client.calls.find(c => /SELECT[\s\S]*FROM user_profile_rollup/i.test(c.sql))!;
        expect(sel.sql).toMatch(/diagnostic/i);
    });
});
