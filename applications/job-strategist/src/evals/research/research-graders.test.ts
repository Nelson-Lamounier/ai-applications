/** @format */
import {
    coverageGrader,
    schemaGrader,
    groundingGrader,
    fitSanityGrader,
    verdictAccuracyGrader,
    runResearchGraders,
    matchingToEvalOutput,
    type ResearchEvalCase,
    type ResearchEvalOutput,
} from './research-graders.js';
import { FIXTURES, GOLDEN_OUTPUT, GOLDEN_OUTPUT_EXPERIENCE } from './fixtures.js';
import { assessmentsToMatching } from '../../agents/research/research-assessment.js';

const CASE = FIXTURES[0]!; // devops-sre-mixed
const EXPERIENCE_CASE = FIXTURES.find((c) => c.name === 'experience-attested-responsibilities')!;

describe('research-graders — golden output', () => {
    it('the golden output passes every grader', () => {
        const report = runResearchGraders(CASE, GOLDEN_OUTPUT);
        const failing = report.results.filter((r) => !r.pass);
        expect(failing).toEqual([]);
        expect(report.pass).toBe(true);
    });

    it('verdictAccuracy is 1.0 when the golden output matches the labelled key', () => {
        const r = verdictAccuracyGrader(CASE, GOLDEN_OUTPUT);
        expect(r.score).toBe(1);
    });
});

describe('research-graders — career-history authority (persona v3, tier 3)', () => {
    it('a career-only verified skill (evidenceFiles: []) passes every grader', () => {
        const report = runResearchGraders(EXPERIENCE_CASE, GOLDEN_OUTPUT_EXPERIENCE);
        const failing = report.results.filter((r) => !r.pass);
        expect(failing).toEqual([]);
        expect(report.pass).toBe(true);
    });

    it('role responsibilities verify on career grounds while the named tool stays partial', () => {
        const r = verdictAccuracyGrader(EXPERIENCE_CASE, GOLDEN_OUTPUT_EXPERIENCE);
        expect(r.score).toBe(1);
    });

    it('schema accepts verified with a sourceCitation but no evidenceFiles (career-only)', () => {
        const careerVerified = GOLDEN_OUTPUT_EXPERIENCE.assessments.filter(
            (a) => a.verdict === 'verified' && (a.evidenceFiles ?? []).length === 0,
        );
        expect(careerVerified.length).toBeGreaterThan(0);
        expect(schemaGrader(EXPERIENCE_CASE, GOLDEN_OUTPUT_EXPERIENCE).pass).toBe(true);
    });
});

describe('coverageGrader', () => {
    it('fails on a missing skill', () => {
        const out: ResearchEvalOutput = { ...GOLDEN_OUTPUT, assessments: GOLDEN_OUTPUT.assessments.slice(0, 5) };
        const r = coverageGrader(CASE, out);
        expect(r.pass).toBe(false);
        expect(r.failures.some((f) => /missing assessment.*8\+ years/.test(f))).toBe(true);
    });

    it('fails on an invented skill', () => {
        const out: ResearchEvalOutput = { ...GOLDEN_OUTPUT, assessments: [...GOLDEN_OUTPUT.assessments, { skill: 'Rust', verdict: 'gap', gapType: 'soft' }] };
        const r = coverageGrader(CASE, out);
        expect(r.failures.some((f) => /invented skill.*Rust/.test(f))).toBe(true);
    });

    it('fails on a duplicate', () => {
        const out: ResearchEvalOutput = { ...GOLDEN_OUTPUT, assessments: [...GOLDEN_OUTPUT.assessments, { skill: 'kubernetes', verdict: 'verified', sourceCitation: 'dup' }] };
        const r = coverageGrader(CASE, out);
        expect(r.failures.some((f) => /duplicate assessment/.test(f))).toBe(true);
    });
});

describe('schemaGrader', () => {
    it('flags a verified entry with no evidence and a partial with no foundation', () => {
        const out: ResearchEvalOutput = {
            ...GOLDEN_OUTPUT,
            assessments: [
                { skill: 'Kubernetes', verdict: 'verified' },
                { skill: 'Terraform', verdict: 'partial' },
                { skill: 'AWS', verdict: 'banana' as never },
            ],
        };
        const r = schemaGrader(CASE, out);
        expect(r.failures.some((f) => /verified without/.test(f))).toBe(true);
        expect(r.failures.some((f) => /partial without transferableFoundation/.test(f))).toBe(true);
        expect(r.failures.some((f) => /invalid verdict "banana"/.test(f))).toBe(true);
    });
});

describe('groundingGrader', () => {
    it('flags a gap that carries evidence (over-claim)', () => {
        const out: ResearchEvalOutput = {
            ...GOLDEN_OUTPUT,
            assessments: [{ skill: 'Go', verdict: 'gap', gapType: 'soft', evidenceFiles: ['me/x.go'] }],
        };
        expect(groundingGrader(CASE, out).pass).toBe(false);
    });
});

describe('fitSanityGrader', () => {
    it('flags STRONG FIT paired with heavy gaps', () => {
        const out: ResearchEvalOutput = { ...GOLDEN_OUTPUT, overallFitRating: 'STRONG FIT' };
        const r = fitSanityGrader(CASE, out); // golden has 2/6 gaps... raise it
        // craft >40% gaps
        const heavy: ResearchEvalOutput = {
            overallFitRating: 'STRONG FIT',
            fitSummary: 'x',
            assessments: [
                { skill: 'a', verdict: 'gap', gapType: 'soft' },
                { skill: 'b', verdict: 'gap', gapType: 'soft' },
                { skill: 'c', verdict: 'gap', gapType: 'soft' },
                { skill: 'd', verdict: 'verified', sourceCitation: 'x' },
            ],
        };
        expect(fitSanityGrader(CASE, heavy).pass).toBe(false);
        // the golden-derived STRONG FIT (2/6 gaps = 33%) is allowed
        expect(r.failures.some((f) => /STRONG FIT/.test(f))).toBe(false);
    });

    it('flags an invalid rating + empty summary', () => {
        const out: ResearchEvalOutput = { overallFitRating: 'AMAZING', fitSummary: '', assessments: [] };
        const r = fitSanityGrader(CASE, out);
        expect(r.failures.some((f) => /invalid overallFitRating/.test(f))).toBe(true);
        expect(r.failures.some((f) => /empty fitSummary/.test(f))).toBe(true);
    });
});

describe('matchingToEvalOutput (round-trip)', () => {
    it('reconstructs an eval output that still covers the canonical list + passes graders', () => {
        // golden assessments → matching → back to eval output, then grade.
        const matching = assessmentsToMatching(GOLDEN_OUTPUT.assessments, CASE.jdSkills);
        const roundTripped = matchingToEvalOutput({ ...matching, overallFitRating: GOLDEN_OUTPUT.overallFitRating, fitSummary: GOLDEN_OUTPUT.fitSummary });
        expect(coverageGrader(CASE, roundTripped).pass).toBe(true);
        expect(verdictAccuracyGrader(CASE, roundTripped).score).toBe(1);
    });
});

describe('verdictAccuracyGrader', () => {
    it('scores the fraction correct and lists mismatches', () => {
        const wrong: ResearchEvalOutput = {
            ...GOLDEN_OUTPUT,
            assessments: GOLDEN_OUTPUT.assessments.map((a) => (a.skill === 'Go' ? { ...a, verdict: 'verified' as const } : a)),
        };
        const r = verdictAccuracyGrader(CASE, wrong);
        expect(r.score).toBeCloseTo(5 / 6, 5);
        expect(r.failures.some((f) => /"Go": expected gap, got verified/.test(f))).toBe(true);
    });

    it('is a no-op pass when the case has no labelled key', () => {
        const noKey: ResearchEvalCase = { name: 'x', jdSkills: ['A'] };
        expect(verdictAccuracyGrader(noKey, { overallFitRating: 'STRETCH', fitSummary: 'x', assessments: [] }).score).toBe(1);
    });
});
