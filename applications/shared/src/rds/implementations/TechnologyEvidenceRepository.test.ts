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
    version: null, githubRepoId: 999,
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
        expect(insert.sql).toContain('DO UPDATE');
        expect(insert.sql).toMatch(/version\s*=\s*EXCLUDED\.version/);
        expect(insert.sql).toMatch(/purl\s*=\s*EXCLUDED\.purl/);
        expect(insert.sql).toMatch(/github_repo_id\s*=\s*EXCLUDED\.github_repo_id/);
        expect(insert.params).toEqual([
            'u1', 'o/r', 'abc', 'id-kube', 'k8s',
            'iac', 'iac', 'deploy.yaml', 3, 3,
            0.85, 5, null, 'pkg:generic/k8s', 999,
        ]);
        expect(client.release).toHaveBeenCalled();
    });

    it('derives a versioned purl for a package-ecosystem row', async () => {
        const client = fakeClient();
        const repo = new TechnologyEvidenceRepository(fakePool(client) as never);
        await repo.insertMany('u1', [{ ...row, rawName: '@aws-sdk/client-s3', ecosystem: 'npm', version: '3.0.0' }]);
        const insert = client.calls.find(c => c.sql.includes('INSERT INTO technology_evidence'))!;
        expect(insert.params!.slice(-3)).toEqual(['3.0.0', 'pkg:npm/%40aws-sdk/client-s3@3.0.0', 999]);
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

describe('TechnologyEvidenceRepository.toCycloneDxBom', () => {
    it('builds an RLS-scoped CycloneDX BOM, deduped with package purls preferred', async () => {
        const client = fakeClient([
            { raw_name: 'cdk-nag', ecosystem: 'npm', version: null, commit_sha: 'sha1' },
            { raw_name: 'cdk-nag', ecosystem: 'typescript', version: null, commit_sha: 'sha1' }, // generic → dropped
            { raw_name: 'react', ecosystem: 'npm', version: '18.2.0', commit_sha: 'sha1' },
        ]);
        const repo = new TechnologyEvidenceRepository(fakePool(client) as never);
        const bom = await repo.toCycloneDxBom('u1', 'o/r');

        expect(client.calls.some(c => c.sql.includes("set_config('app.current_user_id'"))).toBe(true);
        expect(client.calls.some(c => c.sql.includes('FROM technology_evidence'))).toBe(true);
        expect(bom.bomFormat).toBe('CycloneDX');
        expect(bom.specVersion).toBe('1.6');
        expect(bom.metadata.component).toEqual({ type: 'application', name: 'o/r', version: 'sha1' });
        expect(bom.components).toEqual([
            { type: 'library', name: 'cdk-nag', purl: 'pkg:npm/cdk-nag' },
            { type: 'library', name: 'react', purl: 'pkg:npm/react@18.2.0', version: '18.2.0' },
        ]);
    });
});
