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
