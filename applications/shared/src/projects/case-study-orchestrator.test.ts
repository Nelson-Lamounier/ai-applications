/**
 * @format
 * Unit tests for computeInputHash — the stable cache-key hash over the
 * inputs that influence the case-study model output. Commit SHAs and PR
 * identity (number/state/mergedAt) must both feed the hash so a change to
 * the underlying evidence busts the semantic cache.
 */
import { computeInputHash } from './case-study-orchestrator.js';
import type { LoadCaseStudyContextResult } from './case-study-loader.js';
import type { CaseStudyContext } from './case-study-types.js';

type Commit = CaseStudyContext['commits'][number];
type Pull = CaseStudyContext['pulls'][number];

function makeContext(overrides?: {
    commits?: Commit[];
    pulls?: Pull[];
    archetype?: { id: string; name: string } | null;
    stage?: 'junior' | 'mid' | 'senior' | 'staff' | null;
}): LoadCaseStudyContextResult {
    const context: CaseStudyContext = {
        projectId:     'proj-1',
        projectName:   'Example Project',
        tagline:       'A tagline',
        pitch:         'A pitch',
        userOverrides: {},
        components: [
            { id: 'c1', name: 'api', kind: 'service' },
        ],
        repositories: [
            {
                id:              'r1',
                fullName:        'acme/api',
                primaryLanguage: 'TypeScript',
                topics:          ['backend'],
                techStack:       ['node', 'pg'],
                defaultBranch:   'main',
            },
        ],
        commits: overrides?.commits ?? [
            {
                repoFullName: 'acme/api',
                sha:          'abc1234',
                authoredAt:   '2026-01-01T00:00:00.000Z',
                authorName:   'Alice',
                message:      'init',
            },
        ],
        pulls: overrides?.pulls ?? [],
        kbChunks: [],
        archetype: overrides?.archetype ?? null,
        stage:     overrides?.stage ?? null,
    };
    return { userId: 'user-1', context };
}

const onePull: Pull = {
    repoFullName: 'acme/api',
    number:       42,
    title:        'Add feature',
    body:         'body text',
    state:        'open',
    mergedAt:     null,
    htmlUrl:      'https://github.com/acme/api/pull/42',
};

describe('computeInputHash', () => {
    it('is deterministic for identical input', () => {
        expect(computeInputHash(makeContext())).toBe(computeInputHash(makeContext()));
    });

    it('changes when a PR is added', () => {
        const without = computeInputHash(makeContext({ pulls: [] }));
        const withPr  = computeInputHash(makeContext({ pulls: [onePull] }));
        expect(withPr).not.toBe(without);
    });

    it("changes when a PR's state / mergedAt changes", () => {
        const open = computeInputHash(makeContext({ pulls: [onePull] }));
        const merged = computeInputHash(makeContext({
            pulls: [{ ...onePull, state: 'merged', mergedAt: '2026-02-01T00:00:00.000Z' }],
        }));
        expect(merged).not.toBe(open);
    });

    it('changes when a commit sha changes', () => {
        const a = computeInputHash(makeContext({
            commits: [{
                repoFullName: 'acme/api',
                sha:          'abc1234',
                authoredAt:   '2026-01-01T00:00:00.000Z',
                authorName:   'Alice',
                message:      'init',
            }],
        }));
        const b = computeInputHash(makeContext({
            commits: [{
                repoFullName: 'acme/api',
                sha:          'def5678',
                authoredAt:   '2026-01-01T00:00:00.000Z',
                authorName:   'Alice',
                message:      'init',
            }],
        }));
        expect(b).not.toBe(a);
    });

    it('changes when archetype/stage is added; identical when absent', () => {
        const base    = computeInputHash(makeContext());
        const withArch = computeInputHash(makeContext({ archetype: { id: 'production_saas', name: 'Production SaaS Application' }, stage: 'senior' }));
        expect(withArch).not.toBe(base);
        // Two absent-archetype contexts hash identically (cache back-compat).
        expect(computeInputHash(makeContext())).toBe(base);
    });
});
