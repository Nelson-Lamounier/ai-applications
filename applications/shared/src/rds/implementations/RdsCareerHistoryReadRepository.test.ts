import { describe, it, expect, jest } from '@jest/globals';
import { RdsCareerHistoryReadRepository } from './RdsCareerHistoryReadRepository.js';

function fakeClient(rows: unknown[]) {
    const calls: { sql: string; params: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params: params ?? [] });
            if (/user_career_history/i.test(sql)) return { rows };
            return { rows: [] };
        }),
        release: jest.fn(),
    };
}
function fakePool(client: ReturnType<typeof fakeClient>) {
    return { connect: jest.fn(async () => client) } as never;
}

describe('RdsCareerHistoryReadRepository.getResumeForReconciliation', () => {
    it('projects skill/experience/project rows from raw_data', async () => {
        const client = fakeClient([
            { entry_type: 'skill', raw_data: { category: 'Cloud', skills: ['AWS', 'Terraform'] } },
            { entry_type: 'experience', raw_data: { company: 'Acme', title: 'SRE', highlights: ['ran k8s'] } },
            { entry_type: 'project', raw_data: { name: 'infra-cli', description: 'IaC tool' } },
        ]);
        const repo = new RdsCareerHistoryReadRepository(fakePool(client));
        const r = await repo.getResumeForReconciliation('11111111-1111-1111-1111-111111111111');

        expect(r?.skills).toEqual([{ category: 'Cloud', skills: ['AWS', 'Terraform'] }]);
        expect(r?.experience).toEqual([{ company: 'Acme', title: 'SRE', highlights: ['ran k8s'] }]);
        expect(r?.projects).toEqual([{ name: 'infra-cli', description: 'IaC tool' }]);

        const cfg = client.calls.find(c => c.sql.includes('set_config'));
        expect(cfg).toBeDefined();
        expect(cfg!.params[0]).toBe('11111111-1111-1111-1111-111111111111');
        const sel = client.calls.find(c => /user_career_history/i.test(c.sql))!;
        expect(sel.sql).toMatch(/user_career_history/i);
        expect(sel.sql).toMatch(/entry_type\s+IN\s*\(/i);
        expect(client.release).toHaveBeenCalled();
    });

    it('returns undefined when no skill/experience/project rows', async () => {
        const client = fakeClient([]);
        const repo = new RdsCareerHistoryReadRepository(fakePool(client));
        await expect(
            repo.getResumeForReconciliation('22222222-2222-2222-2222-222222222222'),
        ).resolves.toBeUndefined();
    });

    it('tolerates missing/extra/null raw_data without throwing', async () => {
        const client = fakeClient([
            { entry_type: 'skill', raw_data: { category: 'X' } },
            { entry_type: 'experience', raw_data: { company: 'Y', extra: 1 } },
            { entry_type: 'project', raw_data: {} },
            { entry_type: 'experience', raw_data: null },
        ]);
        const repo = new RdsCareerHistoryReadRepository(fakePool(client));
        const r = await repo.getResumeForReconciliation('33333333-3333-3333-3333-333333333333');

        expect(r).toBeDefined();
        expect(r?.skills[0]).toEqual({ category: 'X', skills: [] });
        expect(r?.experience[0]).toEqual({ company: 'Y', title: '', highlights: [] });
        expect(r?.projects[0]).toEqual({ name: '', description: '' });
        expect(r?.experience[1]).toEqual({ company: '', title: '', highlights: [] });
    });
});
