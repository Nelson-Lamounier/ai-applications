/** @format */
import { describe, it, expect } from '@jest/globals';
import type { Pool } from 'pg';

import { reconstructPriorCaseStudy, underrepresentedRepos, scopeEvidenceToRepos } from './case-study-refine.js';
import type { CaseStudyContext, PriorCaseStudy } from './case-study-types.js';

/** Mock pg Pool routing canned rows by a substring match on the SQL. */
function fakePool(routes: Array<{ match: RegExp; rows: unknown[] }>): Pool {
    return {
        query: async (sql: string) => {
            const r = routes.find((x) => x.match.test(sql));
            return { rows: r ? r.rows : [] };
        },
    } as unknown as Pool;
}

const completeProject = { match: /FROM projects/i, rows: [{ tagline: 'T', pitch: 'P', case_study_generated_at: '2026-06-01T00:00:00Z' }] };

describe('reconstructPriorCaseStudy', () => {
    it('returns null when the project has never generated a case study', async () => {
        const pool = fakePool([{ match: /FROM projects/i, rows: [{ tagline: null, pitch: null, case_study_generated_at: null }] }]);
        expect(await reconstructPriorCaseStudy(pool, 'p1')).toBeNull();
    });

    it('still reconstructs mid-regenerate (status pending but generated_at set, rows present)', async () => {
        // The regenerate endpoint flips status to pending before this job runs;
        // refine must survive that by gating on generated_at, not status.
        const prior = await reconstructPriorCaseStudy(fakePool([
            completeProject,
            { match: /FROM project_highlights/i, rows: [{ title: 'H', description: 'd', source_signals: null }] },
        ]), 'p1');
        expect(prior).not.toBeNull();
        expect(prior?.highlights[0].title).toBe('H');
    });

    it('returns null when the project does not exist', async () => {
        expect(await reconstructPriorCaseStudy(fakePool([]), 'p1')).toBeNull();
    });

    it('returns null when the case study is complete but has no rows', async () => {
        expect(await reconstructPriorCaseStudy(fakePool([completeProject]), 'p1')).toBeNull();
    });

    it('reconstructs sections with their stored sourceSignals', async () => {
        const signal = { commits: [{ repoFullName: 'a/b', sha: 'abc1234', authoredAt: 't', message: 'm' }], pulls: [], files: [], ungroundedClaims: [], grounding: 'GROUNDED' };
        const prior = await reconstructPriorCaseStudy(fakePool([
            completeProject,
            { match: /FROM project_decisions/i,  rows: [{ title: 'D', context: 'c', decision: 'x', consequences: 'y', confidence: 'high', source_signals: signal }] },
            { match: /FROM project_highlights/i,  rows: [{ title: 'H', description: 'd', source_signals: signal }] },
            { match: /FROM project_challenges/i,  rows: [{ problem: 'pr', solution: 'so', source_signals: signal }] },
            { match: /FROM project_stack_items/i, rows: [{ category: 'language', name: 'TypeScript', justification: 'j', source_signals: signal }] },
        ]), 'p1');

        expect(prior).not.toBeNull();
        expect(prior?.tagline).toBe('T');
        expect(prior?.decisions[0]).toMatchObject({ title: 'D', confidence: 'high' });
        // sourceSignals are carried verbatim so the agent can preserve grounded rows.
        expect(prior?.decisions[0].sourceSignals.commits[0].sha).toBe('abc1234');
        expect(prior?.highlights[0]).toMatchObject({ title: 'H', description: 'd' });
        expect(prior?.challenges[0]).toMatchObject({ problem: 'pr', solution: 'so' });
        expect(prior?.stack[0]).toMatchObject({ category: 'language', name: 'TypeScript' });
    });

    it('coerces a missing/garbage source_signals into an empty NOT_VERIFIED signal', async () => {
        const prior = await reconstructPriorCaseStudy(fakePool([
            completeProject,
            { match: /FROM project_highlights/i, rows: [{ title: 'H', description: 'd', source_signals: null }] },
        ]), 'p1');
        expect(prior?.highlights[0].sourceSignals).toEqual({ commits: [], pulls: [], files: [], ungroundedClaims: [], grounding: 'NOT_VERIFIED' });
    });

    it('falls back to medium confidence when the stored value is unexpected', async () => {
        const prior = await reconstructPriorCaseStudy(fakePool([
            completeProject,
            { match: /FROM project_decisions/i, rows: [{ title: 'D', context: '', decision: '', consequences: '', confidence: 'bogus', source_signals: null }] },
        ]), 'p1');
        expect(prior?.decisions[0].confidence).toBe('medium');
    });
});

const sig = (repo: string) => ({ commits: [{ repoFullName: repo, sha: 'abc1234', authoredAt: 't', message: 'm' }], pulls: [], files: [], ungroundedClaims: [], grounding: 'NOT_VERIFIED' as const });

function priorWith(repos: string[]): PriorCaseStudy {
    return {
        tagline: 't', pitch: 'p',
        highlights: repos.map((r) => ({ title: `h-${r}`, description: 'd', sourceSignals: sig(r) })),
        decisions: [], challenges: [], stack: [],
    };
}

describe('underrepresentedRepos', () => {
    it('returns repos not grounded by any prior row (newly added)', () => {
        const prior = priorWith(['acme/api']);
        expect(underrepresentedRepos(prior, ['acme/api', 'acme/web'])).toEqual(['acme/web']);
    });

    it('returns [] when the prior already cites every repo', () => {
        const prior = priorWith(['acme/api', 'acme/web']);
        expect(underrepresentedRepos(prior, ['acme/api', 'acme/web'])).toEqual([]);
    });

    it('also counts repos cited only via files (not commits)', () => {
        const prior: PriorCaseStudy = {
            tagline: 't', pitch: 'p', decisions: [], challenges: [], stack: [],
            highlights: [{ title: 'h', description: 'd', sourceSignals: { commits: [], pulls: [], files: [{ repoFullName: 'acme/api', path: 'x' }], ungroundedClaims: [], grounding: 'NOT_VERIFIED' } }],
        };
        expect(underrepresentedRepos(prior, ['acme/api', 'acme/web'])).toEqual(['acme/web']);
    });

    it('preserves the input repo order', () => {
        const prior = priorWith([]);
        expect(underrepresentedRepos(prior, ['c', 'a', 'b'])).toEqual(['c', 'a', 'b']);
    });
});

function ctxWith(repos: string[]): CaseStudyContext {
    return {
        projectId: 'p', projectName: 'P', tagline: null, pitch: null, userOverrides: {},
        components: [], repositories: repos.map((r, i) => ({ id: `r${String(i)}`, fullName: r, primaryLanguage: null, topics: [], techStack: [], defaultBranch: null })),
        commits: repos.map((r) => ({ repoFullName: r, sha: 'abc1234', authoredAt: 't', authorName: 'a', message: 'm' })),
        pulls:   repos.map((r, i) => ({ repoFullName: r, number: i + 1, title: 't', body: null, state: 'open' as const, mergedAt: null, htmlUrl: 'u' })),
        kbChunks: repos.map((r) => ({ repoFullName: r, filePath: 'f', chunkType: 'document', content: 'c' })),
    };
}

describe('scopeEvidenceToRepos', () => {
    it('keeps only the named repos\' commits / pulls / kb, leaving repositories intact', () => {
        const scoped = scopeEvidenceToRepos(ctxWith(['acme/api', 'acme/web']), ['acme/web']);
        expect(scoped.commits.map((c) => c.repoFullName)).toEqual(['acme/web']);
        expect(scoped.pulls.map((p) => p.repoFullName)).toEqual(['acme/web']);
        expect(scoped.kbChunks.map((k) => k.repoFullName)).toEqual(['acme/web']);
        // Full project shape preserved so the agent still sees every repo/component.
        expect(scoped.repositories.map((r) => r.fullName)).toEqual(['acme/api', 'acme/web']);
    });

    it('drops everything when the repo set is empty', () => {
        const scoped = scopeEvidenceToRepos(ctxWith(['acme/api']), []);
        expect(scoped.commits).toEqual([]);
        expect(scoped.kbChunks).toEqual([]);
    });
});
