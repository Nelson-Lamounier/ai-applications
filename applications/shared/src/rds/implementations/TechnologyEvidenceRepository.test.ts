/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { TechnologyEvidenceRepository } from './TechnologyEvidenceRepository.js';
import type { TechnologyEvidenceRow } from '../types/techgraph.js';

function fakeClient(rows: unknown[] = []) {
    const calls: { sql: string; params?: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            return { rows };
        }),
        release: jest.fn(),
    };
}
function fakePool(client: ReturnType<typeof fakeClient>) {
    return { connect: jest.fn(async () => client) };
}

const row: TechnologyEvidenceRow = {
    userId: 'u1', repoFullName: 'o/r', commitSha: 'abc', technologyId: 'id-kube',
    rawName: 'k8s', ecosystem: 'iac', sourceLayer: 'iac',
    filePath: 'deploy.yaml', lineStart: 3, lineEnd: 3, confidence: 0.85, ontologyVersion: 5,
};

describe('TechnologyEvidenceRepository.insertMany', () => {
    it('sets the RLS user and inserts with ON CONFLICT DO NOTHING', async () => {
        const client = fakeClient();
        const repo = new TechnologyEvidenceRepository(fakePool(client) as never);
        await repo.insertMany('u1', [row]);
        const sqls = client.calls.map(c => c.sql).join('\n');
        expect(sqls).toContain("set_config('app.current_user_id'");
        const insert = client.calls.find(c => c.sql.includes('INSERT INTO technology_evidence'))!;
        expect(insert.sql).toContain('ON CONFLICT');
        expect(insert.sql).toContain('DO NOTHING');
        expect(insert.params).toEqual([
            'u1', 'o/r', 'abc', 'id-kube', 'k8s',
            'iac', 'iac', 'deploy.yaml', 3, 3,
            0.85, 5,
        ]);
        expect(client.release).toHaveBeenCalled();
    });

    it('no-ops on an empty batch', async () => {
        const client = fakeClient();
        const repo = new TechnologyEvidenceRepository(fakePool(client) as never);
        await repo.insertMany('u1', []);
        expect(client.calls.find(c => c.sql.includes('INSERT INTO technology_evidence'))).toBeUndefined();
    });
});

describe('TechnologyEvidenceRepository.hasEvidenceForCommit', () => {
    it('returns true when a row exists for (user, repo, sha)', async () => {
        const client = fakeClient([{ one: 1 }]);
        const repo = new TechnologyEvidenceRepository(fakePool(client) as never);
        expect(await repo.hasEvidenceForCommit('u1', 'o/r', 'abc')).toBe(true);
        expect(client.calls.some(c => c.sql.includes("set_config('app.current_user_id'"))).toBe(true);
    });
    it('returns false when no row exists', async () => {
        const client = fakeClient([]);
        const repo = new TechnologyEvidenceRepository(fakePool(client) as never);
        expect(await repo.hasEvidenceForCommit('u1', 'o/r', 'zzz')).toBe(false);
    });
});
