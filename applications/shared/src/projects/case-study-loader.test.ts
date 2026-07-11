/** @format */
import { loadCaseStudyContext, kbRelevanceTerms } from './case-study-loader.js';

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
    difficultyAreas?: unknown[];
    commitSpan?: unknown[];
}) {
    // Table-driven dispatch: first matching predicate wins. Keeps the stub's
    // cognitive complexity flat as queries are added (one row per query).
    const routes: ReadonlyArray<readonly [(sql: string) => boolean, () => unknown[]]> = [
        [(s) => /FROM technology_evidence/.test(s), () => canned.verifiedStack ?? []],
        [(s) => /FROM projects/.test(s), () => canned.projects ?? []],
        [(s) => /FROM project_components/.test(s) && !/FROM project_repositories/.test(s), () => canned.components ?? []],
        [(s) => /FROM project_repositories/.test(s), () => canned.repositories ?? []],
        // Difficulty signals: the fix-density query JOINs commit files to
        // commits; the span query aliases first_commit_at. Both must route
        // before the generic repo_commit_files / repo_commits matchers.
        [(s) => /JOIN repo_commits/.test(s), () => canned.difficultyAreas ?? []],
        [(s) => /first_commit_at/.test(s), () => canned.commitSpan ?? []],
        [(s) => /FROM repo_commit_files/.test(s), () => canned.fileChanges ?? []],
        // Lane-counts is the GROUP BY fileClass aggregate; the KB-chunk SELECT
        // also mentions fileClass now (docs-lane preference), so match on the
        // aggregation instead of the mere column reference.
        [(s) => /FROM document_embeddings/.test(s) && /GROUP BY de\.metadata->>'fileClass'/.test(s), () => canned.laneCounts ?? []],
        [(s) => /FROM document_embeddings/.test(s), () => canned.embeddings ?? []],
        [(s) => /FROM repo_sync_state/.test(s), () => canned.syncState ?? []],
        [(s) => /FROM repo_commits/.test(s), () => canned.commits ?? []],
        [(s) => /FROM repo_pull_requests/.test(s), () => canned.pulls ?? []],
        [(s) => /FROM project_archetypes/.test(s), () => canned.archetypes ?? []],
        [(s) => /FROM project_stage_overlays/.test(s), () => canned.overlays ?? []],
        [(s) => /FROM user_profile_rollup/.test(s), () => canned.rollup ?? []],
        [(s) => /UPDATE projects/.test(s), () => []],
    ];
    const seen: string[] = [];
    return {
        seen,
        async query(sql: string): Promise<QueryResult> {
            seen.push(sql);
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

describe('loadCaseStudyContext — authorship', () => {
    it('maps author_login onto commits and pulls (null-safe)', async () => {
        const pool = makePool({
            projects:     [projectRow],
            repositories: [{ ...repoRow, full_name: 'me/app' }],
            commits: [
                { repo_full_name: 'me/app', sha: 'abc1234', author_name: 'Nelson', author_login: 'nelson', authored_at: '2026-01-01T00:00:00Z', message: 'init' },
                { repo_full_name: 'me/app', sha: 'def5678', author_name: 'Bot',    author_login: null,     authored_at: '2026-01-02T00:00:00Z', message: 'ci' },
            ],
            pulls: [
                { repo_full_name: 'me/app', number: 1, title: 'PR', body: null, state: 'merged', author_login: 'nelson', merged_at: '2026-01-03T00:00:00Z', html_url: 'https://x/1' },
            ],
        });
        const ctx = await loadCaseStudyContext(pool as never, 'proj-uuid');
        expect(ctx.context.commits[0].authorLogin).toBe('nelson');
        expect(ctx.context.commits[1].authorLogin).toBeNull();
        expect(ctx.context.pulls[0].authorLogin).toBe('nelson');
    });
});

describe('kbRelevanceTerms', () => {
    it('derives OR-joined lowercase terms from name + tagline, deduped, ≥4 chars, ≤12', () => {
        const t = kbRelevanceTerms('frontend-portfolio', 'Portfolio platform with a RAG chatbot on EKS!');
        expect(t).toBe('frontend | portfolio | platform | with | chatbot');
        expect(t).not.toMatch(/rag|eks/); // <4 chars filtered
    });
    it('returns empty string when nothing salient derives (caller falls back to recency)', () => {
        expect(kbRelevanceTerms('a-b', 'x y z')).toBe('');
    });
});

describe('loadCaseStudyContext — evidence mix (highlight balance)', () => {
    it('attaches the app/infra mix derived from fileClass lane counts', async () => {
        const pool = makePool({
            projects:     [projectRow],
            components:   [],
            repositories: [repoRow],
            embeddings:   [],
            laneCounts:   [{ fc: 'source', cnt: '141' }, { fc: 'test', cnt: '640' }, { fc: 'iac', cnt: '45' }],
            commits:      [],
            pulls:        [],
        });
        const out = await loadCaseStudyContext(pool as never, 'proj-uuid');
        expect(out.context.evidenceMix).toEqual({ appPct: 95, infraPct: 5, appFiles: 781, infraFiles: 45 });
    });

    it('attaches null when the repos hold only one lane', async () => {
        const pool = makePool({
            projects:     [projectRow],
            components:   [],
            repositories: [repoRow],
            embeddings:   [],
            laneCounts:   [{ fc: 'source', cnt: '100' }],
            commits:      [],
            pulls:        [],
        });
        const out = await loadCaseStudyContext(pool as never, 'proj-uuid');
        expect(out.context.evidenceMix ?? null).toBeNull();
    });
});

describe('loadCaseStudyContext — difficulty signals (challenge recency fix)', () => {
    it('attaches bucketed signals from the full-history fix-density query', async () => {
        const pool = makePool({
            projects:     [projectRow],
            repositories: [repoRow],
            embeddings:   [],
            commits:      [],
            pulls:        [],
            difficultyAreas: [{ area: 'src/auth', fix_commits: '13', total_commits: '38', first_at: '2026-01-15T00:00:00.000Z', last_at: '2026-06-02T00:00:00.000Z' }],
            commitSpan:      [{ first_commit_at: '2025-11-29T00:00:00.000Z', last_commit_at: '2026-07-07T00:00:00.000Z', total: '406' }],
        });
        const out = await loadCaseStudyContext(pool as never, 'proj-uuid');
        expect(out.context.difficultySignals).toEqual({
            firstCommitMonth: '2025-11',
            lastCommitMonth:  '2026-07',
            totalCommits:     405,
            areas: [{ area: 'src/auth', fixCommits: 15, totalCommits: 40, firstMonth: '2026-01', lastMonth: '2026-06' }],
        });
    });

    it('attaches null when the history holds no fix-dense areas', async () => {
        const pool = makePool({
            projects: [projectRow], repositories: [repoRow], embeddings: [], commits: [], pulls: [],
        });
        const out = await loadCaseStudyContext(pool as never, 'proj-uuid');
        expect(out.context.difficultySignals ?? null).toBeNull();
    });
});

describe('loadCaseStudyContext — multi-repo evidence fairness', () => {
    it('interleaves commits per repo so one busy repo cannot monopolise the packer cap', async () => {
        const pool = makePool({
            projects: [projectRow], repositories: [repoRow], embeddings: [], commits: [], pulls: [],
        });
        await loadCaseStudyContext(pool as never, 'proj-uuid');
        const commitsSql = pool.seen.find((s) => /FROM repo_commits\b/.test(s) && /author_name/.test(s));
        expect(commitsSql).toMatch(/ROW_NUMBER\(\) OVER \(PARTITION BY repo_full_name ORDER BY authored_at DESC\)/);
        expect(commitsSql).toMatch(/ORDER BY rn, authored_at DESC/);
    });

    it('scopes difficulty areas per repo and caps each repo share', async () => {
        const pool = makePool({
            projects: [projectRow], repositories: [repoRow], embeddings: [], commits: [], pulls: [],
        });
        await loadCaseStudyContext(pool as never, 'proj-uuid');
        const diffSql = pool.seen.find((s) => /JOIN repo_commits/.test(s));
        // Area labels carry the repo so `.github/workflows` in four repos never
        // merges into one fake battle; each repo holds at most 3 of the 8 slots.
        expect(diffSql).toMatch(/split_part\(.*repo.*'\/'.*2\)/);
        expect(diffSql).toMatch(/PARTITION BY repo/);
        expect(diffSql).toMatch(/rpr <= 3/);
    });

    it('caps KB chunks per repo so relevance ranking cannot starve member repos', async () => {
        const pool = makePool({
            projects: [projectRow], repositories: [repoRow], embeddings: [], commits: [], pulls: [],
        });
        await loadCaseStudyContext(pool as never, 'proj-uuid');
        const kbSql = pool.seen.find((s) => /content_tsv/.test(s) && /LIMIT/.test(s));
        expect(kbSql).toMatch(/PARTITION BY .*repo_full_name/);
        expect(kbSql).toMatch(/rpr <= 12/);
    });
});

describe('loadCaseStudyContext — sticky stage override', () => {
    it('uses user_overrides.stage instead of the rollup-derived stage', async () => {
        const pool = makePool({
            projects: [{ ...projectRow, type: 'production_saas', user_overrides: { stage: 'staff' } }],
            components: [],
            repositories: [{ ...repoRow, tech_stack: ['docker'] }],
            embeddings: [],
            syncState: [{ archetype_signals: { has_iac: true } }],
            commits: [], pulls: [],
            archetypes: [{ id: 'production_saas', name: 'Production SaaS Application', description: 'd',
                classification_signals: { required_any: ['has_iac'], positive: [], negative: [] },
                expected_sections: [], expected_artifacts: [] }],
            overlays: [{ archetype_id: 'production_saas', stage: 'staff',
                priority_sections: ['architecture'], deemphasized_sections: [], stage_suggestions: [] }],
            rollup: [{ direction: { seniority: [{ area: 'backend', level: 'junior' }] } }],
        });
        const out = await loadCaseStudyContext(pool as never, 'proj-uuid');
        expect(out.context.stage).toBe('staff');
    });
});
