/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { RdsDiagnosticInputsReadRepository } from './RdsDiagnosticInputsReadRepository.js';

/**
 * fakeClient — scripted multi-query fake.
 *
 * Matches the SP4 sibling fake (`RdsCareerHistoryReadRepository.test.ts`)
 * shape (`calls`, `query`, `release` + `connect`-pool wrapper) but routes
 * by table substring since this repo issues two distinct projection queries.
 *
 *   - `repo_sync_state`      → kbRows
 *   - `user_career_history`  → resumeRows
 *   - anything else (BEGIN / set_config / COMMIT / ROLLBACK) → empty rows
 */
function fakeClient(opts: { kbRows: unknown[]; resumeRows: unknown[] }) {
    const calls: { sql: string; params: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params: params ?? [] });
            if (/repo_sync_state/i.test(sql))     return { rows: opts.kbRows };
            if (/user_career_history/i.test(sql)) return { rows: opts.resumeRows };
            return { rows: [] };
        }),
        release: jest.fn(),
    };
}
function fakePool(client: ReturnType<typeof fakeClient>) {
    return { connect: jest.fn(async () => client) } as never;
}

const USER_ID = '11111111-1111-1111-1111-111111111111';

describe('RdsDiagnosticInputsReadRepository.getDiagnosticInputs', () => {
    it('projects KB stats + résumé counts, scopes RLS by userId', async () => {
        const client = fakeClient({
            kbRows: [{ project_count: 5, high_kb_count: 2, avg_retrieval: '0.74' }],
            resumeRows: [
                { entry_type: 'skill',      count: '3' },
                { entry_type: 'experience', count: '4' },
                { entry_type: 'project',    count: '1' },
            ],
        });
        const repo = new RdsDiagnosticInputsReadRepository(fakePool(client));
        const r = await repo.getDiagnosticInputs(USER_ID);

        expect(r.kbStats).toEqual({
            projectRepoCount:     5,
            reposWithHighKbScore: 2,
            avgRetrievalScore:    0.74,
        });
        expect(r.resumePresent).toBe(true);
        expect(r.resumeEntryCounts).toEqual({ skills: 3, experience: 4, projects: 1 });

        const cfg = client.calls.find(c => c.sql.includes('set_config'));
        expect(cfg).toBeDefined();
        expect(cfg!.params[0]).toBe(USER_ID);
        expect(client.release).toHaveBeenCalled();
    });

    it('returns honest zeros + null + false for a user with no data (does NOT throw)', async () => {
        const client = fakeClient({
            kbRows: [{ project_count: 0, high_kb_count: 0, avg_retrieval: null }],
            resumeRows: [],
        });
        const repo = new RdsDiagnosticInputsReadRepository(fakePool(client));
        const r = await repo.getDiagnosticInputs(USER_ID);

        expect(r.kbStats).toEqual({ projectRepoCount: 0, reposWithHighKbScore: 0, avgRetrievalScore: null });
        expect(r.resumePresent).toBe(false);
        expect(r.resumeEntryCounts).toEqual({ skills: 0, experience: 0, projects: 0 });
    });

    it('tolerates extra/unknown entry_type rows without throwing', async () => {
        const client = fakeClient({
            kbRows: [{ project_count: 1, high_kb_count: 1, avg_retrieval: '0.55' }],
            resumeRows: [
                { entry_type: 'skill',         count: '1' },
                { entry_type: 'education',     count: '2' },
                { entry_type: 'unknown_thing', count: '9' },
            ],
        });
        const repo = new RdsDiagnosticInputsReadRepository(fakePool(client));
        const r = await repo.getDiagnosticInputs(USER_ID);

        expect(r.resumePresent).toBe(true);
        expect(r.resumeEntryCounts).toEqual({ skills: 1, experience: 0, projects: 0 });
    });

    it('PROPAGATES a thrown database error', async () => {
        const failingPool: unknown = {
            connect: jest.fn(async () => ({
                query: jest.fn(async (sql: string) => {
                    if (/SET|set_config|BEGIN/i.test(sql)) return { rows: [] };
                    if (/repo_sync_state/i.test(sql)) throw new Error('connection reset');
                    return { rows: [] };
                }),
                release: jest.fn(),
            })),
        };
        const repo = new RdsDiagnosticInputsReadRepository(failingPool as never);
        await expect(repo.getDiagnosticInputs(USER_ID)).rejects.toThrow('connection reset');
    });
});
