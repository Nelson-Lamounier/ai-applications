/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import type { Pool } from 'pg';
import { buildProjectPool, loadProjectAgentInputs, loadProjectAgentMeta } from '../project-agent-inputs.js';

const bulletSets = [{ name: 'Tucaken', bullets: ['Built an event-driven API on SQS/SNS', 'Cut sync time 40%'] }];
const projectMeta = [{
    projectId: 'proj-1', name: 'Tucaken', pitch: 'A job platform for candidates.', tagline: 'Land your next job faster.',
    repositoryIds: ['repo-uuid-1'], repoFullNames: ['o/tucaken-app'],
    repoKinds: new Map([['o/tucaken-app', 'backend']]),
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
        const meta2 = [...projectMeta, {
            projectId: 'proj-2', name: 'Infra', pitch: 'Infra for Tucaken.', tagline: '',
            repositoryIds: ['repo-uuid-1'], repoFullNames: ['o/tucaken-app'],
            repoKinds: new Map([['o/tucaken-app', 'backend']]),
        }];
        const r = buildProjectPool([...bulletSets, { name: 'Infra', bullets: ['Provisioned EKS'] }], meta2, repoLookup, matches.slice(0, 1));
        expect(r.pool[0]!.repoCurrent).toHaveLength(1);
        expect(r.pool[1]!.repoCurrent).toHaveLength(1);
    });

    // G3: tagline threads from ProjectAgentMeta into the pool entry so
    // stampProjectDescription callers can fall back to it when pitch is empty.
    it('threads tagline from project meta into the pool entry', () => {
        const r = buildProjectPool(bulletSets, projectMeta, repoLookup, matches);
        expect(r.pool[0]!.tagline).toBe('Land your next job faster.');
    });

    // Integration-shaped: operations-evidence.ts's gatherOperationsEvidence
    // output threaded through the REAL buildProjectPool, proving reuse of its
    // fail-closed repository-ID attribution (not a duplicate check) -- a
    // theme fact whose file resolves to a repo outside the OWNING project
    // attributes nowhere, exactly like any other VerifiedMatch.
    it('operations-evidence facts flow through buildProjectPool with the SAME fail-closed cross-project attribution as any other verified match', async () => {
        const { gatherOperationsEvidence } = await import('../operations-evidence.js');
        const dbTheme = {
            key: 'database-operations', label: 'database operations',
            queryTerms: 'database operations connection pooling migrations schema backup production',
            matchTerms: ['database'], kinds: ['backend', 'infra'],
        };
        const metaA = {
            projectId: 'proj-a', name: 'A', pitch: '', tagline: '',
            repositoryIds: ['repo-a'], repoFullNames: ['o/app-a'],
            repoKinds: new Map([['o/app-a', 'backend']]),
        };
        const metaB = {
            projectId: 'proj-b', name: 'B', pitch: '', tagline: '',
            repositoryIds: ['repo-b'], repoFullNames: ['o/app-b'],
            repoKinds: new Map([['o/app-b', 'backend']]),
        };
        const retrieve = async (): Promise<Array<{ file: string; text: string }>> => [
            { file: 'o/app-a/docs/db.md', text: 'Production Postgres runs pgbouncer transaction pooling.' },
        ];
        const gathered = await gatherOperationsEvidence({ themes: [dbTheme], projects: [metaA, metaB], retrieve });

        const opsRepoLookup = new Map([
            ['o/app-a', { id: 'repo-a', githubRepoId: 1 }],
            ['o/app-b', { id: 'repo-b', githubRepoId: 2 }],
        ]);
        const built = buildProjectPool([], [metaA, metaB], opsRepoLookup, gathered.matches);

        expect(built.pool[0]!.repoCurrent).toHaveLength(1);
        expect(built.pool[0]!.repoCurrent[0]).toMatchObject({ skill: 'database operations', fullName: 'o/app-a' });
        expect(built.pool[1]!.repoCurrent).toHaveLength(0);
    });
});

/** Mock pool: connect() returns a client whose query() resolves rows keyed on table-name substring. */
function mockPool(rowsByTable: {
    projects: Array<{ id: string; name: string; pitch: string; tagline?: string }>;
    projectRepositories: Array<{ project_id: string; repository_id: string; full_name: string; github_repo_id: number | null; kind?: string }>;
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
            projects: [{ id: 'proj-1', name: 'Tucaken', pitch: 'A job platform for candidates.', tagline: 'Land your next job faster.' }],
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
        expect(p.tagline).toBe('Land your next job faster.');
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

describe('loadProjectAgentMeta -- kind threading (operations-evidence prerequisite)', () => {
    it('threads project_components.kind per repo into ProjectAgentMeta.repoKinds', async () => {
        const userId = 'user-3';
        const { pool } = mockPool({
            projects: [{ id: 'proj-1', name: 'Tucaken', pitch: '' }],
            projectRepositories: [
                { project_id: 'proj-1', repository_id: 'repo-uuid-1', full_name: 'o/tucaken-app', github_repo_id: 42, kind: 'backend' },
                { project_id: 'proj-1', repository_id: 'repo-uuid-2', full_name: 'o/tucaken-ml', github_repo_id: 43, kind: 'ml' },
            ],
            projectResumeBullets: [],
        });

        const { projectMeta } = await loadProjectAgentMeta(pool, userId);

        expect(projectMeta).toHaveLength(1);
        const meta = projectMeta[0]!;
        expect(meta.repoFullNames).toEqual(['o/tucaken-app', 'o/tucaken-ml']);
        expect(meta.repoKinds.get('o/tucaken-app')).toBe('backend');
        expect(meta.repoKinds.get('o/tucaken-ml')).toBe('ml');
    });

    it('falls back to an empty-string kind when the row carries none (predates the kind join)', async () => {
        const userId = 'user-4';
        const { pool } = mockPool({
            projects: [{ id: 'proj-1', name: 'Tucaken', pitch: '' }],
            projectRepositories: [
                { project_id: 'proj-1', repository_id: 'repo-uuid-1', full_name: 'o/tucaken-app', github_repo_id: 42 },
            ],
            projectResumeBullets: [],
        });

        const { projectMeta } = await loadProjectAgentMeta(pool, userId);
        expect(projectMeta[0]!.repoKinds.get('o/tucaken-app')).toBe('');
    });

    it('returns bulletSets and repoLookup alongside projectMeta, matching buildProjectPool through the same wiring loadProjectAgentInputs uses', async () => {
        const userId = 'user-5';
        const { pool } = mockPool({
            projects: [{ id: 'proj-1', name: 'Tucaken', pitch: 'A job platform.', tagline: '' }],
            projectRepositories: [
                { project_id: 'proj-1', repository_id: 'repo-uuid-1', full_name: 'o/tucaken-app', github_repo_id: 42, kind: 'backend' },
            ],
            projectResumeBullets: [
                { name: 'Tucaken', angle: 'infrastructure', bullets: ['Built an event-driven API on SQS/SNS'] },
            ],
        });

        const { bulletSets, projectMeta, repoLookup } = await loadProjectAgentMeta(pool, userId);
        const built = buildProjectPool(bulletSets, projectMeta, repoLookup, [
            { skill: 'DNS', sourceCitation: 'o/tucaken-app/infra/dns.ts', evidenceFiles: ['o/tucaken-app/infra/dns.ts'] },
        ]);

        expect(built.pool[0]!.curated.map((b) => b.text)).toEqual(['Built an event-driven API on SQS/SNS']);
        expect(built.pool[0]!.repoCurrent).toHaveLength(1);
    });
});
