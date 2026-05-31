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
}) {
    return {
        async query(sql: string): Promise<QueryResult> {
            if (/FROM projects/.test(sql))            return { rows: canned.projects ?? [] };
            if (/FROM project_components/.test(sql) && !/FROM project_repositories/.test(sql)) {
                return { rows: canned.components ?? [] };
            }
            if (/FROM project_repositories/.test(sql)) return { rows: canned.repositories ?? [] };
            if (/FROM document_embeddings/.test(sql)) return { rows: canned.embeddings ?? [] };
            if (/FROM repo_commits/.test(sql))        return { rows: canned.commits ?? [] };
            if (/FROM repo_pull_requests/.test(sql))  return { rows: canned.pulls ?? [] };
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
});
