import { computeUserProfileRollup } from './computeUserProfileRollup.js';
import type { ProfileAggInput } from './computeUserProfileRollup.js';

function row(p: Partial<ProfileAggInput> = {}): ProfileAggInput {
    return {
        repoFullName:     'o/r',
        classification:   'project',
        isHidden:         false,
        extractionStatus: 'completed',
        primaryLanguage:  'TypeScript',
        commitCount:      10,
        lastActiveAt:     '2026-01-01T00:00:00Z',
        domain:           'infra',
        complexity:       'moderate',
        roleInferred:     'creator',
        techStack:        ['AWS', 'Kubernetes'],
        ...p,
    };
}

describe('computeUserProfileRollup — scope', () => {
    it('headline aggregates only project + !hidden + completed', () => {
        const res = computeUserProfileRollup([
            row({ repoFullName: 'o/a' }),
            row({ repoFullName: 'o/b', classification: 'fork' }),
            row({ repoFullName: 'o/c', isHidden: true }),
            row({ repoFullName: 'o/d', extractionStatus: 'failed' }),
        ]);
        expect(res.projectRepoCount).toBe(1);
        expect(res.totalRepoCount).toBe(4);
        expect(res.rollup.totals.projectRepoCount).toBe(1);
    });

    it('classificationCounts reflects ALL rows incl. hidden', () => {
        const res = computeUserProfileRollup([
            row({ classification: 'project' }),
            row({ classification: 'fork' }),
            row({ classification: 'tutorial', isHidden: true }),
        ]);
        expect(res.rollup.classificationCounts.project).toBe(1);
        expect(res.rollup.classificationCounts.fork).toBe(1);
        expect(res.rollup.classificationCounts.tutorial).toBe(1);
        expect(res.rollup.classificationCounts.hiddenCount).toBe(1);
    });
});

describe('computeUserProfileRollup — aggregates', () => {
    it('ranks languages by commit-volume proxy with sharePct', () => {
        const res = computeUserProfileRollup([
            row({ repoFullName: 'o/a', primaryLanguage: 'TypeScript', commitCount: 30 }),
            row({ repoFullName: 'o/b', primaryLanguage: 'TypeScript', commitCount: 10 }),
            row({ repoFullName: 'o/c', primaryLanguage: 'Python',     commitCount: 10 }),
        ]);
        expect(res.rollup.languages[0]).toEqual({
            language: 'TypeScript', repoCount: 2, commitVolumeProxy: 40, sharePct: 80,
        });
        expect(res.rollup.languages[1]).toEqual({
            language: 'Python', repoCount: 1, commitVolumeProxy: 10, sharePct: 20,
        });
    });

    it('null primary language buckets as "unknown"', () => {
        const res = computeUserProfileRollup([row({ primaryLanguage: null, commitCount: 5 })]);
        expect(res.rollup.languages[0].language).toBe('unknown');
    });

    it('domains: counts + dominant', () => {
        const res = computeUserProfileRollup([
            row({ repoFullName: 'o/a', domain: 'infra' }),
            row({ repoFullName: 'o/b', domain: 'infra' }),
            row({ repoFullName: 'o/c', domain: 'web' }),
        ]);
        expect(res.rollup.domains.counts).toEqual({ infra: 2, web: 1 });
        expect(res.rollup.domains.dominant).toBe('infra');
    });

    it('complexity + roles counts', () => {
        const res = computeUserProfileRollup([
            row({ repoFullName: 'o/a', complexity: 'complex', roleInferred: 'creator' }),
            row({ repoFullName: 'o/b', complexity: 'simple',  roleInferred: 'contributor' }),
        ]);
        expect(res.rollup.complexity).toEqual({ simple: 1, moderate: 0, complex: 1 });
        expect(res.rollup.roles).toEqual({ creator: 1, maintainer: 0, contributor: 1 });
    });

    it('techStackTop frequency, ranked, name tiebreak', () => {
        const res = computeUserProfileRollup([
            row({ repoFullName: 'o/a', techStack: ['AWS', 'Docker'] }),
            row({ repoFullName: 'o/b', techStack: ['AWS', 'Zod'] }),
        ]);
        expect(res.rollup.techStackTop[0]).toEqual({ tech: 'AWS', repoCount: 2 });
        expect(res.rollup.techStackTop.slice(1)).toEqual([
            { tech: 'Docker', repoCount: 1 },
            { tech: 'Zod',    repoCount: 1 },
        ]);
    });

    it('activityArc ascending; null lastActiveAt excluded; activeYearsApprox', () => {
        const res = computeUserProfileRollup([
            row({ repoFullName: 'o/late', lastActiveAt: '2026-01-01T00:00:00Z' }),
            row({ repoFullName: 'o/early', lastActiveAt: '2024-01-01T00:00:00Z' }),
            row({ repoFullName: 'o/none', lastActiveAt: null }),
        ]);
        expect(res.rollup.activityArc.map(e => e.repoFullName)).toEqual(['o/early', 'o/late']);
        expect(res.rollup.totals.earliestActivity).toBe('2024-01-01T00:00:00Z');
        expect(res.rollup.totals.latestActivity).toBe('2026-01-01T00:00:00Z');
        expect(res.rollup.totals.activeYearsApprox).toBe(2);
    });

    it('empty input → deterministic empty rollup, still well-formed', () => {
        const res = computeUserProfileRollup([]);
        expect(res).toMatchObject({
            projectRepoCount: 0, totalRepoCount: 0, methodologyVersion: 1,
        });
        expect(res.rollup.languages).toEqual([]);
        expect(res.rollup.domains).toEqual({ counts: {}, dominant: null });
        expect(res.rollup.totals.activeYearsApprox).toBe(0);
        expect(res.rollup.methodology.version).toBe(1);
    });

    it('is deterministic for the same input', () => {
        const input = [row({ repoFullName: 'o/a' }), row({ repoFullName: 'o/b', primaryLanguage: 'Go' })];
        expect(computeUserProfileRollup(input)).toEqual(computeUserProfileRollup(input));
    });
});
