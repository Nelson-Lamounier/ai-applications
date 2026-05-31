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
}) {
    return {
        async query(sql: string): Promise<QueryResult> {
            if (/FROM projects/.test(sql))            return { rows: canned.projects ?? [] };
            if (/FROM project_components/.test(sql) && !/FROM project_repositories/.test(sql)) {
                return { rows: canned.components ?? [] };
            }
            if (/FROM project_repositories/.test(sql)) return { rows: canned.repositories ?? [] };
            if (/FROM document_embeddings/.test(sql)) return { rows: canned.embeddings ?? [] };
            if (/FROM repo_sync_state/.test(sql))     return { rows: canned.syncState ?? [] };
            if (/FROM repo_commits/.test(sql))        return { rows: canned.commits ?? [] };
            if (/FROM repo_pull_requests/.test(sql))  return { rows: canned.pulls ?? [] };
            if (/FROM project_archetypes/.test(sql))      return { rows: canned.archetypes ?? [] };
            if (/FROM project_stage_overlays/.test(sql))  return { rows: canned.overlays ?? [] };
            if (/FROM user_profile_rollup/.test(sql))     return { rows: canned.rollup ?? [] };
            if (/UPDATE projects/.test(sql))              return { rows: [] };
            throw new Error(`unexpected SQL: ${sql}`);
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
