/**
 * @format
 * Research-agent (matcher) per-phase eval — offline structural graders.
 *
 * These validate the assessment-only contract (centralisation increment 2)
 * WITHOUT calling Bedrock: given a canonical JD skill list + the matcher's
 * emitted assessments, do they hold the guarantees the refactor promises?
 *   - coverage     : exactly one assessment per canonical skill, none invented
 *   - schema       : each assessment has a valid verdict + the fields that verdict needs
 *   - grounding    : verified/partial carry evidence; gaps are honestly empty
 *   - fitSanity    : valid fit rating + non-empty summary; STRONG FIT not paired with heavy gaps
 *   - verdictAccuracy (optional): emitted verdicts vs a labelled answer key
 *
 * Pure + deterministic. The live Haiku↔Sonnet A/B runner (run-research-eval.ts)
 * feeds real model output through these same graders.
 */
import type { GraderResult } from '../graders.js';
import { mkResult } from '../graders.js';
import type { SkillAssessment, Verdict } from '../../agents/research/research-assessment.js';

/** One eval case: the fixed skill list + (optional) the expected verdict per skill. */
export interface ResearchEvalCase {
    readonly name: string;
    readonly jdSkills: string[];
    readonly expectedVerdicts?: Record<string, Verdict>;
}

/** The matcher output fields the graders inspect. */
export interface ResearchEvalOutput {
    readonly assessments: SkillAssessment[];
    readonly overallFitRating: string;
    readonly fitSummary: string;
}

const VALID_VERDICTS: ReadonlySet<string> = new Set(['verified', 'partial', 'gap']);
const VALID_FIT: ReadonlySet<string> = new Set(['STRONG FIT', 'REASONABLE FIT', 'STRETCH', 'REACH']);

const norm = (s: string): string => s.trim().toLowerCase();

/** Fractional GraderResult (mkResult is pass/fail only). */
function scored(grader: string, score: number, failures: string[]): GraderResult {
    return { grader, pass: failures.length === 0, score, failures };
}

/**
 * Coverage: exactly one assessment per canonical skill — none missing, none
 * duplicated, none invented (an assessment whose skill isn't in the list).
 * This is the core guarantee of the assessment-only refactor.
 */
export function coverageGrader(c: ResearchEvalCase, out: ResearchEvalOutput): GraderResult {
    const failures: string[] = [];
    const canonical = new Map(c.jdSkills.map((s) => [norm(s), s]));
    const seen = new Map<string, number>();

    for (const a of out.assessments) {
        const key = norm(a.skill ?? '');
        seen.set(key, (seen.get(key) ?? 0) + 1);
        if (!canonical.has(key)) failures.push(`invented skill not in JD list: "${a.skill}"`);
    }
    for (const [key, original] of canonical) {
        const n = seen.get(key) ?? 0;
        if (n === 0) failures.push(`missing assessment for JD skill: "${original}"`);
        else if (n > 1) failures.push(`duplicate assessment (${n}×) for JD skill: "${original}"`);
    }
    return mkResult('coverage', failures);
}

function hasText(s?: string): boolean {
    return typeof s === 'string' && s.trim().length > 0;
}

/** The required-field failure for a (valid-verdict) assessment, or null if ok. */
function verdictFieldFailure(a: SkillAssessment, label: string): string | null {
    if (a.verdict === 'verified') {
        return hasText(a.sourceCitation) || (a.evidenceFiles ?? []).length > 0
            ? null
            : `"${label}": verified without sourceCitation or evidenceFiles`;
    }
    if (a.verdict === 'partial') {
        return hasText(a.transferableFoundation) ? null : `"${label}": partial without transferableFoundation`;
    }
    return a.gapType ? null : `"${label}": gap without gapType`;
}

/** Schema failures for ONE assessment (extracted to keep schemaGrader simple). */
function assessmentSchemaFailures(a: SkillAssessment): string[] {
    const label = a.skill || '(blank)';
    if (!a.verdict || !VALID_VERDICTS.has(a.verdict)) return [`"${label}": invalid verdict "${a.verdict}"`];
    const failure = verdictFieldFailure(a, label);
    return failure ? [failure] : [];
}

/** Schema: each assessment has a valid verdict + the fields that verdict requires. */
export function schemaGrader(_c: ResearchEvalCase, out: ResearchEvalOutput): GraderResult {
    return mkResult('schema', out.assessments.flatMap(assessmentSchemaFailures));
}

/** Grounding: gaps must be honestly empty (no citation/files); verified/partial carry evidence. */
export function groundingGrader(_c: ResearchEvalCase, out: ResearchEvalOutput): GraderResult {
    const failures: string[] = [];
    for (const a of out.assessments) {
        const label = a.skill || '(blank)';
        if (a.verdict === 'gap' && ((a.evidenceFiles ?? []).length > 0 || a.sourceCitation?.trim())) {
            failures.push(`"${label}": gap must not carry evidence (over-claim)`);
        }
    }
    return mkResult('grounding', failures);
}

/** Fit sanity: valid rating + non-empty summary; STRONG FIT inconsistent with heavy gaps. */
export function fitSanityGrader(_c: ResearchEvalCase, out: ResearchEvalOutput): GraderResult {
    const failures: string[] = [];
    if (!VALID_FIT.has(out.overallFitRating)) failures.push(`invalid overallFitRating "${out.overallFitRating}"`);
    if (!out.fitSummary?.trim()) failures.push('empty fitSummary');

    const total = out.assessments.length;
    const gaps = out.assessments.filter((a) => a.verdict === 'gap').length;
    if (total > 0 && out.overallFitRating === 'STRONG FIT' && gaps / total > 0.4) {
        failures.push(`STRONG FIT with ${gaps}/${total} gaps (>40%) — inconsistent`);
    }
    return mkResult('fitSanity', failures);
}

/**
 * Verdict accuracy vs a labelled answer key (optional). Score = fraction of
 * labelled skills whose emitted verdict matches. No-op pass when no key is given.
 */
export function verdictAccuracyGrader(c: ResearchEvalCase, out: ResearchEvalOutput): GraderResult {
    if (!c.expectedVerdicts || Object.keys(c.expectedVerdicts).length === 0) {
        return scored('verdictAccuracy', 1, []);
    }
    const emitted = new Map(out.assessments.map((a) => [norm(a.skill ?? ''), a.verdict]));
    const failures: string[] = [];
    const labels = Object.entries(c.expectedVerdicts);
    let correct = 0;
    for (const [skill, expected] of labels) {
        const got = emitted.get(norm(skill));
        if (got === expected) correct++;
        else failures.push(`"${skill}": expected ${expected}, got ${got ?? 'none'}`);
    }
    return scored('verdictAccuracy', labels.length === 0 ? 1 : correct / labels.length, failures);
}

/** All structural graders, in display order. */
export const RESEARCH_GRADERS: ReadonlyArray<(c: ResearchEvalCase, o: ResearchEvalOutput) => GraderResult> = [
    coverageGrader,
    schemaGrader,
    groundingGrader,
    fitSanityGrader,
    verdictAccuracyGrader,
];

/** Run every grader; overall pass = all pass. */
export function runResearchGraders(c: ResearchEvalCase, out: ResearchEvalOutput): { pass: boolean; results: GraderResult[] } {
    const results = RESEARCH_GRADERS.map((g) => g(c, out));
    return { pass: results.every((r) => r.pass), results };
}

/** The derived-matching subset the reconstruct helper reads. */
interface MatchingLike {
    readonly verifiedMatches: ReadonlyArray<{ skill: string; sourceCitation?: string; depth?: string; recency?: string; evidenceFiles?: string[] }>;
    readonly partialMatches: ReadonlyArray<{ skill: string; gapDescription?: string; transferableFoundation?: string; framingSuggestion?: string; evidenceFiles?: string[] }>;
    readonly gaps: ReadonlyArray<{ skill: string; gapType?: string; impactSeverity?: string; disqualifyingAssessment?: string }>;
    readonly overallFitRating: string;
    readonly fitSummary: string;
}

/**
 * Reconstruct the assessment-level eval view from a derived ResearchMatching
 * (the inverse of assessmentsToMatching). Lets the live runner grade the REAL
 * matcher output — which returns the three buckets — with the same structural
 * graders the offline fixtures use.
 */
export function matchingToEvalOutput(m: MatchingLike): ResearchEvalOutput {
    const assessments: SkillAssessment[] = [
        ...m.verifiedMatches.map((v) => ({ skill: v.skill, verdict: 'verified' as Verdict, sourceCitation: v.sourceCitation, depth: v.depth as SkillAssessment['depth'], recency: v.recency, evidenceFiles: v.evidenceFiles })),
        ...m.partialMatches.map((p) => ({ skill: p.skill, verdict: 'partial' as Verdict, gapDescription: p.gapDescription, transferableFoundation: p.transferableFoundation, framingSuggestion: p.framingSuggestion, evidenceFiles: p.evidenceFiles })),
        ...m.gaps.map((g) => ({ skill: g.skill, verdict: 'gap' as Verdict, gapType: g.gapType as SkillAssessment['gapType'], impactSeverity: g.impactSeverity as SkillAssessment['impactSeverity'], disqualifyingAssessment: g.disqualifyingAssessment })),
    ];
    return { assessments, overallFitRating: m.overallFitRating, fitSummary: m.fitSummary };
}
