/** @format */
import { loadCaseStudyContext } from './case-study-loader.js';

interface QueryResult {
    rows: unknown[];
}

/**
 * A fake pg Pool whose `query(sql)` dispatches on the SQL text. Each loader
 * query is matched by a regex so tests can supply canned rows per table.
 */
function makePool(canned: {
    projects?: unknown[];
    components?: unknown[];
    repositories?: unknown[];
    embeddings?: unknown[];
    commits?: unknown[];
    pulls?: unknown[];
    archetypes?: unknown[];
    overlays?: unknown[];
    rollup?: unknown[];
    syncState?: unknown[];
    fileChanges?: unknown[];
    laneCounts?: unknown[];
    verifiedStack?: unknown[];
}) {
    // Table-driven dispatch: first matching predicate wins. Keeps the stub's
    // cognitive complexity flat as queries are added (one row per query).
    const routes: ReadonlyArray<readonly [(sql: string) => boolean, () => unknown[]]> = [
        [(s) => /FROM technology_evidence/.test(s), () => canned.verifiedStack ?? []],
        [(s) => /FROM projects/.test(s), () => canned.projects ?? []],
        [(s) => /FROM project_components/.test(s) && !/FROM project_repositories/.test(s), () => canned.components ?? []],
        [(s) => /FROM project_repositories/.test(s), () => canned.repositories ?? []],
        [(s) => /FROM repo_commit_files/.test(s), () => canned.fileChanges ?? []],
        [(s) => /FROM document_embeddings/.test(s) && /fileClass/.test(s), () => canned.laneCounts ?? []],
        [(s) => /FROM document_embeddings/.test(s), () => canned.embeddings ?? []],
        [(s) => /FROM repo_sync_state/.test(s), () => canned.syncState ?? []],
        [(s) => /FROM repo_commits/.test(s), () => canned.commits ?? []],
        [(s) => /FROM repo_pull_requests/.test(s), () => canned.pulls ?? []],
        [(s) => /FROM project_archetypes/.test(s), () => canned.archetypes ?? []],
        [(s) => /FROM project_stage_overlays/.test(s), () => canned.overlays ?? []],
        [(s) => /FROM user_profile_rollup/.test(s), () => canned.rollup ?? []],
        [(s) => /UPDATE projects/.test(s), () => []],
    ];
    return {
        async query(sql: string): Promise<QueryResult> {
            const route = routes.find(([match]) => match(sql));
            if (!route) throw new Error(`unexpected SQL: ${sql}`);
            return { rows: route[1]() };
        },
    };
}

const projectRow = {
    id:             'proj-uuid',
    user_id:        'user-uuid',
    name:           'My Project',
    tagline:        'A tagline',
    pitch:          'A pitch',
    user_overrides: {},
    type:           'side_project',
    shape:          'single_repo',
};

const repoRow = {
    id:               'repo-uuid',
    full_name:        'owner/repo',
    primary_language: 'TypeScript',
    topics:           ['web'],
    tech_stack:       ['react'],
    default_branch:   'main',
};

describe('loadCaseStudyContext', () => {
    it('reads commits + PRs from repo_commits / repo_pull_requests', async () => {
        const pool = makePool({
            projects:     [projectRow],
            components:   [],
            repositories: [repoRow],
            embeddings:   [],
            commits: [{
                repo_full_name: 'owner/repo',
                sha:            'abc1234',
                author_name:    'Nelson',
                authored_at:    '2026-01-02T00:00:00.000Z',
                message:        'feat: thing',
            }],
            pulls: [{
                repo_full_name: 'owner/repo',
                number:         42,
                title:          'Add thing',
                body:           'body text',
                state:          'merged',
                merged_at:      '2026-01-03T00:00:00.000Z',
                html_url:       'https://github.com/owner/repo/pull/42',
            }],
        });

        const out = await loadCaseStudyContext(pool as never, 'proj-uuid');

        expect(out.userId).toBe('user-uuid');
        expect(out.context.commits).toHaveLength(1);
        expect(out.context.commits[0].sha).toBe('abc1234');
        expect(out.context.commits[0].repoFullName).toBe('owner/repo');
        expect(out.context.pulls).toHaveLength(1);
        expect(out.context.pulls[0].number).toBe(42);
        expect(out.context.pulls[0].state).toBe('merged');
    });

    it('attaches grounded depthMarkers (from fileClass + archetype) and file-change evidence', async () => {
        const pool = makePool({
            projects:     [projectRow],
            components:   [],
            repositories: [repoRow],
            embeddings:   [],
            syncState:    [{ archetype_signals: { has_ci: true, has_argocd_apps: true, has_iac: true } }],
            laneCounts:   [{ fc: 'test', cnt: '640' }, { fc: 'source', cnt: '141' }, { fc: 'iac', cnt: '45' }],
            fileChanges:  [{ repo_full_name: 'owner/repo', file_path: 'infra/main.tf', additions: '120', deletions: '10', changes: '130' }],
            commits:      [{ repo_full_name: 'owner/repo', sha: 'r1', author_name: 'N', authored_at: '2026-01-01T00:00:00.000Z', message: 'refactor: tidy loop' }],
            pulls:        [],
        });

        const out = await loadCaseStudyContext(pool as never, 'proj-uuid');

        // depthMarkers are measured, not guessed.
        expect(out.context.depthMarkers).toMatchObject({
            hasTests: true, testCoverageSignal: 'strong', hasCi: true, ciMaturity: 'multi_env', hasDeploymentEvidence: true, refactorCount: 1,
        });
        // real file-level evidence is surfaced for the agent to cite.
        expect(out.context.fileChangeEvidence).toEqual([
            { repoFullName: 'owner/repo', filePath: 'infra/main.tf', additions: 120, deletions: 10, changes: 130 },
        ]);
    });

    it('returns empty commits + pulls when the tables have no matching rows', async () => {
        const pool = makePool({
            projects:     [projectRow],
            components:   [],
            repositories: [repoRow],
            embeddings:   [],
            commits:      [],
            pulls:        [],
        });

        const out = await loadCaseStudyContext(pool as never, 'proj-uuid');

        expect(out.context.commits).toEqual([]);
        expect(out.context.pulls).toEqual([]);
    });

    it('classifies archetype + stage, persists, and attaches calibration', async () => {
        const pool = makePool({
            projects: [{ ...projectRow, type: 'production_saas', shape: 'multi_repo' }],
            components: [],
            repositories: [{ ...repoRow, tech_stack: ['docker','kubernetes'] }],
            embeddings: [{ repo_full_name: 'owner/repo', file_path: 'infra/k8s/deploy.yaml', chunk_type: 'document', content: 'x' }],
            syncState: [{ archetype_signals: { has_iac: true, has_ci: true } }],
            commits: [], pulls: [],
            archetypes: [{ id: 'production_saas', name: 'Production SaaS Application', description: 'd',
                classification_signals: { required_any: ['has_iac'], positive: ['has_ci'], negative: [] },
                expected_sections: ['architecture'], expected_artifacts: [] }],
            overlays: [{ archetype_id: 'production_saas', stage: 'senior',
                priority_sections: ['architecture','deployment'], deemphasized_sections: [], stage_suggestions: [] }],
            rollup: [{ direction: { seniority: [{ area: 'backend', level: 'senior' }] } }],
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out = await loadCaseStudyContext(pool as any, 'proj-uuid');
        expect(out.context.archetype?.id).toBe('production_saas');
        expect(out.context.stage).toBe('senior');
        expect(out.context.prioritySections).toEqual(['architecture','deployment']);
    });

    it('attaches no calibration when classification finds nothing (graceful fallback)', async () => {
        const pool = makePool({
            projects: [{ ...projectRow, type: 'side_project', shape: 'single_repo' }],
            components: [], repositories: [{ ...repoRow, tech_stack: [] }],
            embeddings: [], syncState: [{ archetype_signals: {} }], commits: [], pulls: [],
            archetypes: [{ id: 'production_saas', name: 'P', description: 'd',
                classification_signals: { required_any: ['has_iac'], positive: [], negative: [] },
                expected_sections: [], expected_artifacts: [] }],
            rollup: [],
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out = await loadCaseStudyContext(pool as any, 'proj-uuid');
        expect(out.context.archetype ?? null).toBeNull();
        expect(out.context.stage ?? null).toBeNull();
    });
});
