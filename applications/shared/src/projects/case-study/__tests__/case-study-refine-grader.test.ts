/** @format */
import { describe, it, expect } from '@jest/globals';

import {
    gradeNewRepoCoverage,
    gradeNoDuplicates,
    gradeCaps,
    gradePriorContinuity,
    runRefineGraders,
} from '../case-study-refine-grader.js';
import type { CaseStudy, PriorCaseStudy, SourceSignal } from '../case-study-types.js';

const sig = (repo?: string): SourceSignal => ({
    commits: repo ? [{ repoFullName: repo, sha: 'abc1234', authoredAt: 't', message: 'm' }] : [],
    pulls: [], files: [], ungroundedClaims: [], grounding: 'NOT_VERIFIED',
});

const DEPTH = {
    hasTests: false, testCoverageSignal: 'none' as const, hasCi: false, ciMaturity: 'none' as const,
    documentationDensity: 'readme_only' as const, hasDeploymentEvidence: false, refactorCount: 0,
};
const ARCH = { diagramFormat: 'mermaid' as const, diagramSource: 'graph TD; a-->b', nodes: [], edges: [] };

function caseStudy(over: Partial<CaseStudy> = {}): CaseStudy {
    return {
        tagline: 't', pitch: 'p', stack: [], decisions: [], highlights: [], challenges: [],
        depthMarkers: DEPTH, architecture: ARCH, resumeBullets: [{ angle: 'backend', bullets: ['x'] }],
        ...over,
    };
}

const emptyPrior: PriorCaseStudy = { tagline: 't', pitch: 'p', decisions: [], highlights: [], challenges: [], stack: [] };

describe('gradeNewRepoCoverage', () => {
    it('passes when each new repo is grounded in a highlight AND a challenge', () => {
        const refined = caseStudy({
            highlights: [{ title: 'h', description: 'd', sourceSignals: sig('acme/web') }],
            challenges: [{ problem: 'p', solution: 's', sourceSignals: sig('acme/web') }],
        });
        const r = gradeNewRepoCoverage({ prior: emptyPrior, newRepos: ['acme/web'], refined });
        expect(r.pass).toBe(true);
    });

    it('fails when a new repo appears only in the stack (the live regression)', () => {
        const refined = caseStudy({
            stack: [{ category: 'framework', name: 'React', justification: 'j', sourceSignals: sig('acme/web') }],
            highlights: [{ title: 'h', description: 'd', sourceSignals: sig('acme/api') }],
            challenges: [{ problem: 'p', solution: 's', sourceSignals: sig('acme/api') }],
        });
        const r = gradeNewRepoCoverage({ prior: emptyPrior, newRepos: ['acme/web'], refined });
        expect(r.pass).toBe(false);
        expect(r.failures.join(' ')).toMatch(/not grounded in any highlight/);
        expect(r.failures.join(' ')).toMatch(/not grounded in any challenge/);
    });

    it('fails when covered in highlights but not challenges', () => {
        const refined = caseStudy({
            highlights: [{ title: 'h', description: 'd', sourceSignals: sig('acme/web') }],
            challenges: [{ problem: 'p', solution: 's', sourceSignals: sig('acme/api') }],
        });
        const r = gradeNewRepoCoverage({ prior: emptyPrior, newRepos: ['acme/web'], refined });
        expect(r.failures).toEqual(['new repo "acme/web" not grounded in any challenge']);
    });
});

describe('gradeNoDuplicates', () => {
    it('flags reworded near-duplicate highlight titles', () => {
        const refined = caseStudy({
            highlights: [
                { title: 'Recall improved', description: 'a', sourceSignals: sig() },
                { title: 'recall   IMPROVED', description: 'b', sourceSignals: sig() },
            ],
        });
        expect(gradeNoDuplicates({ prior: emptyPrior, newRepos: [], refined }).pass).toBe(false);
    });

    it('passes distinct titles', () => {
        const refined = caseStudy({
            highlights: [
                { title: 'A', description: 'a', sourceSignals: sig() },
                { title: 'B', description: 'b', sourceSignals: sig() },
            ],
        });
        expect(gradeNoDuplicates({ prior: emptyPrior, newRepos: [], refined }).pass).toBe(true);
    });
});

describe('gradeCaps', () => {
    it('fails when a section exceeds its cap', () => {
        const refined = caseStudy({
            highlights: Array.from({ length: 6 }, (_, i) => ({ title: `h${String(i)}`, description: 'd', sourceSignals: sig() })),
        });
        expect(gradeCaps({ prior: emptyPrior, newRepos: [], refined }).pass).toBe(false);
    });
});

describe('gradePriorContinuity', () => {
    it('is a no-op for a thin prior (<3 highlights)', () => {
        const prior: PriorCaseStudy = { ...emptyPrior, highlights: [{ title: 'a', description: 'd', sourceSignals: sig() }] };
        expect(gradePriorContinuity({ prior, newRepos: [], refined: caseStudy() }).pass).toBe(true);
    });

    it('fails when a substantial prior is entirely discarded', () => {
        const prior: PriorCaseStudy = {
            ...emptyPrior,
            highlights: ['a', 'b', 'c'].map((t) => ({ title: t, description: 'd', sourceSignals: sig() })),
        };
        const refined = caseStudy({ highlights: [{ title: 'totally new', description: 'd', sourceSignals: sig() }] });
        const r = gradePriorContinuity({ prior, newRepos: [], refined });
        expect(r.pass).toBe(false);
        expect(r.score).toBe(0);
    });

    it('scores partial retention', () => {
        const prior: PriorCaseStudy = {
            ...emptyPrior,
            highlights: ['a', 'b', 'c', 'd'].map((t) => ({ title: t, description: 'd', sourceSignals: sig() })),
        };
        const refined = caseStudy({ highlights: [{ title: 'a', description: 'd', sourceSignals: sig() }, { title: 'b', description: 'd', sourceSignals: sig() }] });
        const r = gradePriorContinuity({ prior, newRepos: [], refined });
        expect(r.pass).toBe(true);
        expect(r.score).toBe(0.5);
    });
});

describe('runRefineGraders', () => {
    it('aggregates pass across all graders', () => {
        const refined = caseStudy({
            highlights: [{ title: 'h', description: 'd', sourceSignals: sig('acme/web') }],
            challenges: [{ problem: 'p', solution: 's', sourceSignals: sig('acme/web') }],
        });
        const report = runRefineGraders({ prior: emptyPrior, newRepos: ['acme/web'], refined });
        expect(report.pass).toBe(true);
        expect(report.results.map((r) => r.grader)).toEqual(['newRepoCoverage', 'noDuplicates', 'caps', 'priorContinuity']);
    });
});
