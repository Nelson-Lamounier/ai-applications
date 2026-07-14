/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import type { Pool } from 'pg';
import { buildProjectPool, loadProjectAgentInputs } from '../project-agent-inputs.js';

const bulletSets = [{ name: 'Tucaken', bullets: ['Built an event-driven API on SQS/SNS', 'Cut sync time 40%'] }];
const projectMeta = [{
    projectId: 'proj-1', name: 'Tucaken', pitch: 'A job platform for candidates.',
    repositoryIds: ['repo-uuid-1'], repoFullNames: ['o/tucaken-app'],
}];
const repoLookup = new Map([
    ['o/tucaken-app', { id: 'repo-uuid-1', githubRepoId: 42 }],
    ['o/lonely-repo', { id: 'repo-uuid-9', githubRepoId: 9 }],
]);
const matches = [
    { skill: 'DNS', sourceCitation: 'o/tucaken-app/infra/dns.ts', evidenceFiles: ['o/tucaken-app/infra/dns.ts'] },
    { skill: 'Kafka', sourceCitation: 'o/other-repo/stream.ts', evidenceFiles: ['o/other-repo/stream.ts'] }, // repo unresolved (not in lookup)
    { skill: 'Go', sourceCitation: 'career history', evidenceFiles: [] }, // no repo provenance
    { skill: 'TLS', sourceCitation: 'o/renamed-repo/tls.ts', evidenceFiles: ['o/renamed-repo/tls.ts'] }, // unresolvable name
    { skill: 'Redis', sourceCitation: 'o/lonely-repo/cache.ts', evidenceFiles: ['o/lonely-repo/cache.ts'] }, // resolves, but owned by no project
];

describe('buildProjectPool', () => {
    it('indexes curated bullets and attributes matches by repository id', () => {
        const r = buildProjectPool(bulletSets, projectMeta, repoLookup, matches);
        const p = r.pool[0]!;
        expect(p.curated.map((b) => b.id)).toEqual(['p0.b0', 'p0.b1']);
        expect(p.repoCurrent).toHaveLength(1);
        expect(p.repoCurrent[0]).toMatchObject({ id: 'p0.r0', skill: 'DNS', repositoryId: 'repo-uuid-1', githubRepoId: 42, fullName: 'o/tucaken-app' });
    });

    it('fails closed: no-provenance and unowned-repo matches attribute nowhere; unresolved names are reported', () => {
        const r = buildProjectPool(bulletSets, projectMeta, repoLookup, matches);
        expect(r.pool[0]!.repoCurrent.map((f) => f.skill)).not.toContain('Kafka');
        expect(r.pool[0]!.repoCurrent.map((f) => f.skill)).not.toContain('Go');
        // o/other-repo is not in repoLookup at all, so it is BOTH unresolved AND unowned.
        expect(r.unresolvedRepos.sort()).toEqual(['o/other-repo', 'o/renamed-repo']);
    });

    it('a repo that resolves via the lookup but is owned by no project attributes nowhere and is not reported unresolved', () => {
        const r = buildProjectPool(bulletSets, projectMeta, repoLookup, matches);
        expect(r.pool[0]!.repoCurrent.map((f) => f.skill)).not.toContain('Redis');
        expect(r.unresolvedRepos).not.toContain('o/lonely-repo');
    });

    it('a repo owned by two projects contributes its matches to both', () => {
        const meta2 = [...projectMeta, { projectId: 'proj-2', name: 'Infra', pitch: 'Infra for Tucaken.', repositoryIds: ['repo-uuid-1'], repoFullNames: ['o/tucaken-app'] }];
        const r = buildProjectPool([...bulletSets, { name: 'Infra', bullets: ['Provisioned EKS'] }], meta2, repoLookup, matches.slice(0, 1));
        expect(r.pool[0]!.repoCurrent).toHaveLength(1);
        expect(r.pool[1]!.repoCurrent).toHaveLength(1);
    });
});

/** Mock pool: connect() returns a client whose query() resolves rows keyed on table-name substring. */
function mockPool(rowsByTable: {
    projects: Array<{ id: string; name: string; pitch: string }>;
    projectRepositories: Array<{ project_id: string; repository_id: string; full_name: string; github_repo_id: number | null }>;
    projectResumeBullets: Array<{ name: string; angle: string; bullets: unknown }>;
}) {
    const release = jest.fn();
    const query = jest.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>().mockImplementation((sql) => {
        if (/FROM projects p\b/i.test(sql) || (/FROM projects\b/i.test(sql) && !/project_repositories|project_resume_bullets/i.test(sql))) {
            return Promise.resolve({ rows: rowsByTable.projects });
        }
        if (/FROM project_repositories/i.test(sql)) {
            return Promise.resolve({ rows: rowsByTable.projectRepositories });
        }
        if (/FROM project_resume_bullets/i.test(sql)) {
            return Promise.resolve({ rows: rowsByTable.projectResumeBullets });
        }
        return Promise.resolve({ rows: [] });
    });
    const connect = jest.fn<() => Promise<{ query: typeof query; release: typeof release }>>()
        .mockResolvedValue({ query, release });
    return { pool: { connect } as unknown as Pool, connect, query, release };
}

describe('loadProjectAgentInputs -- RLS-scoped two-lane read', () => {
    it('assembles the pool from projects + project_repositories + resume bullets, filtered by userId', async () => {
        const userId = '1d4c645a-447e-4b5b-924d-19a3c75a84db';
        const { pool, query } = mockPool({
            projects: [{ id: 'proj-1', name: 'Tucaken', pitch: 'A job platform for candidates.' }],
            projectRepositories: [
                { project_id: 'proj-1', repository_id: 'repo-uuid-1', full_name: 'o/tucaken-app', github_repo_id: 42 },
            ],
            projectResumeBullets: [
                { name: 'Tucaken', angle: 'infrastructure', bullets: ['Built an event-driven API on SQS/SNS'] },
            ],
        });

        const result = await loadProjectAgentInputs(pool, userId, [
            { skill: 'DNS', sourceCitation: 'o/tucaken-app/infra/dns.ts', evidenceFiles: ['o/tucaken-app/infra/dns.ts'] },
        ]);

        expect(result.pool).toHaveLength(1);
        const p = result.pool[0]!;
        expect(p.name).toBe('Tucaken');
        expect(p.repoUrls).toEqual(['github.com/o/tucaken-app']);
        expect(p.curated.map((b) => b.text)).toEqual(['Built an event-driven API on SQS/SNS']);
        expect(p.repoCurrent).toHaveLength(1);
        expect(p.repoCurrent[0]).toMatchObject({ skill: 'DNS', repositoryId: 'repo-uuid-1', fullName: 'o/tucaken-app' });

        // Every query issued must parameterise on userId ($1).
        for (const call of query.mock.calls) {
            const sql = call[0] as string;
            const params = call[1] as unknown[] | undefined;
            if (/^BEGIN$|^COMMIT$/i.test(sql.trim())) continue;
            expect(params).toContain(userId);
        }
    });

    it('reports unresolved repo names when a citation cannot be matched to a repository row', async () => {
        const userId = 'user-2';
        const { pool } = mockPool({
            projects: [{ id: 'proj-1', name: 'Tucaken', pitch: '' }],
            projectRepositories: [
                { project_id: 'proj-1', repository_id: 'repo-uuid-1', full_name: 'o/tucaken-app', github_repo_id: 42 },
            ],
            projectResumeBullets: [],
        });

        const result = await loadProjectAgentInputs(pool, userId, [
            { skill: 'TLS', sourceCitation: 'o/renamed-repo/tls.ts', evidenceFiles: ['o/renamed-repo/tls.ts'] },
        ]);

        expect(result.unresolvedRepos).toEqual(['o/renamed-repo']);
        expect(result.pool[0]!.repoCurrent).toHaveLength(0);
    });
});
