/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { gatherOperationsEvidence, cleanSnippet, type RetrievedPassage } from '../operations-evidence.js';
import type { ProjectAgentMeta } from '../project-agent-inputs.js';
import type { OperationsTheme } from '../operations-themes.js';

type Retrieve = (query: string, k: number) => Promise<ReadonlyArray<RetrievedPassage>>;

const dbTheme: OperationsTheme = {
    key: 'database-operations',
    label: 'database operations',
    queryTerms: 'database operations connection pooling migrations schema backup production',
    matchTerms: ['database', 'mongodb', 'postgresql'],
    kinds: ['backend', 'infra'],
};

const perfTheme: OperationsTheme = {
    key: 'performance-tuning',
    label: 'performance tuning',
    queryTerms: 'performance tuning latency memory profiling optimisation benchmark',
    matchTerms: ['performance', 'tuning'],
    kinds: ['backend', 'infra', 'ml'],
};

function project(overrides: Partial<ProjectAgentMeta> = {}): ProjectAgentMeta {
    return {
        projectId: 'proj-1',
        name: 'Tucaken',
        pitch: 'career platform',
        tagline: '',
        repositoryIds: ['r1', 'r2'],
        repoFullNames: ['o/tucaken-app', 'o/tucaken-ml'],
        repoKinds: new Map([
            ['o/tucaken-app', 'backend'],
            ['o/tucaken-ml', 'ml'],
        ]),
        ...overrides,
    };
}

describe('cleanSnippet', () => {
    it('strips markdown (fences, inline code, links, headings, emphasis) and collapses whitespace', () => {
        const raw = '# Pooling\n\nWe run `pgbouncer` in **transaction** mode, see [docs](https://x) for detail.\n\n```sql\nSELECT 1;\n```\nDone.';
        const cleaned = cleanSnippet(raw);
        expect(cleaned).not.toContain('#');
        expect(cleaned).not.toContain('`');
        expect(cleaned).not.toContain('**');
        expect(cleaned).not.toContain('[docs]');
        expect(cleaned).not.toContain('SELECT 1');
        expect(cleaned).toContain('pgbouncer');
    });

    it('caps at 200 characters', () => {
        const long = 'pgbouncer transaction pooling '.repeat(20);
        expect(cleanSnippet(long).length).toBeLessThanOrEqual(200);
    });
});

describe('gatherOperationsEvidence', () => {
    it('returns empty result with zero retrieval calls when no themes are activated', async () => {
        const retrieve = jest.fn<Retrieve>().mockResolvedValue([]);
        const result = await gatherOperationsEvidence({ themes: [], projects: [project()], retrieve });
        expect(result).toEqual({ matches: [], factCounts: {}, byRepo: {} });
        expect(retrieve).not.toHaveBeenCalled();
    });

    it('skips retrieval entirely for a (project, theme) pair with no kind-matching member repo', async () => {
        const retrieve = jest.fn<Retrieve>().mockResolvedValue([]);
        // storage only targets 'infra' -- this project has no infra repo.
        const storageTheme: OperationsTheme = { ...dbTheme, key: 'storage', label: 'storage', kinds: ['infra'] };
        await gatherOperationsEvidence({ themes: [storageTheme], projects: [project()], retrieve });
        expect(retrieve).not.toHaveBeenCalled();
    });

    it('kind filter: rejects a chunk from the ml repo for a [backend, infra] theme even though the project owns it', async () => {
        const retrieve = jest.fn<Retrieve>().mockResolvedValue([
            { file: 'o/tucaken-ml/notebooks/train.md', text: 'Trained the ranking model on GPU nodes.' },
            { file: 'o/tucaken-app/docs/db.md', text: 'Production Postgres runs pgbouncer in transaction pooling mode.' },
        ]);
        const result = await gatherOperationsEvidence({ themes: [dbTheme], projects: [project()], retrieve });
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]!.evidenceFiles).toEqual(['o/tucaken-app/docs/db.md']);
    });

    it('rejects a chunk whose file resolves to a repo the project does not own at all', async () => {
        const retrieve = jest.fn<Retrieve>().mockResolvedValue([
            { file: 'o/someone-elses-repo/infra/db.md', text: 'Unrelated production database notes.' },
        ]);
        const result = await gatherOperationsEvidence({ themes: [dbTheme], projects: [project()], retrieve });
        expect(result.matches).toHaveLength(0);
    });

    it('prefers docs-lane chunks (.md/.mdx or /docs/ path) over non-docs chunks when both are in scope', async () => {
        const retrieve = jest.fn<Retrieve>().mockResolvedValue([
            { file: 'o/tucaken-app/src/db/pool.ts', text: 'pool.ts source: configures pgbouncer client options.' },
            { file: 'o/tucaken-app/docs/database-operations.md', text: 'Runbook: pgbouncer transaction pooling in production.' },
        ]);
        const result = await gatherOperationsEvidence({
            themes: [dbTheme],
            projects: [project({ repoFullNames: ['o/tucaken-app'], repoKinds: new Map([['o/tucaken-app', 'backend']]) })],
            retrieve,
        });
        expect(result.matches[0]!.evidenceFiles).toEqual(['o/tucaken-app/docs/database-operations.md']);
    });

    it('caps at 2 facts per (project, theme) even when more chunks qualify', async () => {
        const retrieve = jest.fn<Retrieve>().mockResolvedValue([
            { file: 'o/tucaken-app/docs/a.md', text: 'Backup snapshot procedure one.' },
            { file: 'o/tucaken-app/docs/b.md', text: 'Backup snapshot procedure two.' },
            { file: 'o/tucaken-app/docs/c.md', text: 'Backup snapshot procedure three.' },
        ]);
        const result = await gatherOperationsEvidence({
            themes: [dbTheme],
            projects: [project({ repoFullNames: ['o/tucaken-app'], repoKinds: new Map([['o/tucaken-app', 'backend']]) })],
            retrieve,
        });
        expect(result.matches).toHaveLength(2);
    });

    it('caps at 6 facts per project across multiple themes', async () => {
        const retrieve = jest.fn<Retrieve>().mockImplementation(() => Promise.resolve([
            { file: 'o/tucaken-app/docs/a.md', text: 'Fact one about this theme in production.' },
            { file: 'o/tucaken-app/docs/b.md', text: 'Fact two about this theme in production.' },
            { file: 'o/tucaken-app/docs/c.md', text: 'Fact three about this theme in production.' },
        ]));
        const themes = [dbTheme, perfTheme, { ...dbTheme, key: 'backup-recovery', label: 'backup recovery' }, { ...dbTheme, key: 'security-hardening', label: 'security hardening' }];
        const result = await gatherOperationsEvidence({
            themes,
            projects: [project({ repoFullNames: ['o/tucaken-app'], repoKinds: new Map([['o/tucaken-app', 'backend']]) })],
            retrieve,
        });
        expect(result.matches).toHaveLength(6);
    });

    it('records skill=theme.label, a cleaned sourceCitation, and factCounts keyed by theme key', async () => {
        const retrieve = jest.fn<Retrieve>().mockResolvedValue([
            { file: 'o/tucaken-app/docs/db.md', text: '# Database Ops\n\nRuns **pgbouncer** in transaction mode.' },
        ]);
        const result = await gatherOperationsEvidence({
            themes: [dbTheme],
            projects: [project({ repoFullNames: ['o/tucaken-app'], repoKinds: new Map([['o/tucaken-app', 'backend']]) })],
            retrieve,
        });
        expect(result.matches[0]).toMatchObject({ skill: 'database operations', evidenceFiles: ['o/tucaken-app/docs/db.md'] });
        expect(result.matches[0]!.sourceCitation).not.toContain('#');
        expect(result.matches[0]!.sourceCitation).not.toContain('**');
        expect(result.factCounts).toEqual({ 'database-operations': 1 });
        expect(result.byRepo).toEqual({ 'o/tucaken-app': 1 });
    });

    it('drops a chunk whose cleaned snippet is empty (whitespace/markdown-only text)', async () => {
        const retrieve = jest.fn<Retrieve>().mockResolvedValue([
            { file: 'o/tucaken-app/docs/empty.md', text: '```\n\n```' },
        ]);
        const result = await gatherOperationsEvidence({
            themes: [dbTheme],
            projects: [project({ repoFullNames: ['o/tucaken-app'], repoKinds: new Map([['o/tucaken-app', 'backend']]) })],
            retrieve,
        });
        expect(result.matches).toHaveLength(0);
    });

    it('error fail-open: a retrieve() rejection for one (project, theme) pair yields no facts for that pair without throwing, and other pairs still proceed', async () => {
        const retrieve = jest.fn<Retrieve>()
            .mockImplementationOnce(() => Promise.reject(new Error('bedrock 500')))
            .mockImplementationOnce(() => Promise.resolve([
                { file: 'o/tucaken-app/docs/perf.md', text: 'Tuned query latency under load.' },
            ]));
        const result = await gatherOperationsEvidence({
            themes: [dbTheme, perfTheme],
            projects: [project({ repoFullNames: ['o/tucaken-app'], repoKinds: new Map([['o/tucaken-app', 'backend']]) })],
            retrieve,
        });
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]!.skill).toBe('performance tuning');
    });

    it('a fact from one project is never attributed to another project sharing the same theme (project-scoped retrieval)', async () => {
        const retrieve = jest.fn<Retrieve>().mockResolvedValue([
            { file: 'o/tucaken-app/docs/db.md', text: 'Production Postgres pooling notes.' },
        ]);
        const projA = project({ projectId: 'a', name: 'A', repoFullNames: ['o/tucaken-app'], repoKinds: new Map([['o/tucaken-app', 'backend']]) });
        const projB = project({ projectId: 'b', name: 'B', repoFullNames: ['o/other-app'], repoKinds: new Map([['o/other-app', 'backend']]) });
        const result = await gatherOperationsEvidence({ themes: [dbTheme], projects: [projA, projB], retrieve });
        // Project B's retrieval call returns the same mocked passages (shared query terms),
        // but the file does not resolve to any of Project B's member repos.
        expect(result.matches).toHaveLength(1);
        expect(result.byRepo).toEqual({ 'o/tucaken-app': 1 });
    });
});
