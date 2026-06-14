/**
 * @format
 * Deterministic graders for the incremental case-study REFINE phase (CLAUDE.md §5).
 *
 * String/array checks only — no LLM call — so they run in CI on every refine-prompt
 * change AND can grade the output of a live agent run. They encode the guarantees the
 * refine prompt promises:
 *
 *   - newRepoCoverage : every newly-added repo appears in ≥1 highlight AND ≥1 challenge
 *                       (grounded by sourceSignals), not just the stack. This is the
 *                       regression the live E2E surfaced (tucaken-app landed in stack only).
 *   - noDuplicates    : refine must not re-emit a prior item as a reworded near-duplicate.
 *   - capsRespected   : ≤5 decisions / highlights / challenges, ≤40 stack.
 *   - priorContinuity  : a non-trivial prior should not be wholesale discarded (soft).
 */
import type { CaseStudy, PriorCaseStudy, SourceSignal } from './case-study-types.js';

export interface RefineGradeInput {
    /** The prior case study fed to the refine agent. */
    readonly prior: PriorCaseStudy;
    /** Repos under-represented in the prior (from `underrepresentedRepos`) — must be covered. */
    readonly newRepos: readonly string[];
    /** The refine agent's output. */
    readonly refined: CaseStudy;
}

export interface RefineGradeResult {
    readonly grader: string;
    readonly pass: boolean;
    readonly score: number; // 0..1
    readonly failures: readonly string[];
}

export interface RefineGradeReport {
    readonly pass: boolean;
    readonly results: readonly RefineGradeResult[];
}

const mk = (grader: string, failures: string[], score?: number): RefineGradeResult => ({
    grader,
    pass: failures.length === 0,
    score: score ?? (failures.length === 0 ? 1 : 0),
    failures,
});

const normalize = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** Repos a row cites, via its grounding signals (commits + files). */
function signalRepos(sig: SourceSignal): Set<string> {
    const s = new Set<string>();
    for (const c of sig.commits) s.add(c.repoFullName);
    for (const f of sig.files)   s.add(f.repoFullName);
    return s;
}

/** A newly-added repo must appear in ≥1 highlight AND ≥1 challenge (grounded). */
export function gradeNewRepoCoverage(input: RefineGradeInput): RefineGradeResult {
    const failures: string[] = [];
    const highlightRepos = new Set<string>();
    for (const h of input.refined.highlights) for (const r of signalRepos(h.sourceSignals)) highlightRepos.add(r);
    const challengeRepos = new Set<string>();
    for (const c of input.refined.challenges) for (const r of signalRepos(c.sourceSignals)) challengeRepos.add(r);

    for (const repo of input.newRepos) {
        if (!highlightRepos.has(repo)) failures.push(`new repo "${repo}" not grounded in any highlight`);
        if (!challengeRepos.has(repo)) failures.push(`new repo "${repo}" not grounded in any challenge`);
    }
    return mk('newRepoCoverage', failures);
}

/** No two rows in a section share a normalized title/problem (reworded near-dupes). */
export function gradeNoDuplicates(input: RefineGradeInput): RefineGradeResult {
    const failures: string[] = [];
    const dupKeys = (label: string, keys: string[]): void => {
        const seen = new Set<string>();
        for (const k of keys) {
            if (seen.has(k)) failures.push(`${label}: duplicate "${k}"`);
            seen.add(k);
        }
    };
    dupKeys('highlights', input.refined.highlights.map((h) => normalize(h.title)));
    dupKeys('challenges', input.refined.challenges.map((c) => normalize(c.problem)));
    dupKeys('decisions',  input.refined.decisions.map((d) => normalize(d.title)));
    return mk('noDuplicates', failures);
}

/** Section caps the schema enforces — graded here so a prompt change can't silently rely on truncation. */
export function gradeCaps(input: RefineGradeInput): RefineGradeResult {
    const failures: string[] = [];
    const cap = (label: string, n: number, max: number): void => {
        if (n > max) failures.push(`${label}: ${String(n)} exceeds cap ${String(max)}`);
    };
    cap('decisions',  input.refined.decisions.length, 5);
    cap('highlights', input.refined.highlights.length, 5);
    cap('challenges', input.refined.challenges.length, 5);
    cap('stack',      input.refined.stack.length, 40);
    return mk('caps', failures);
}

/**
 * Soft continuity: a non-trivial prior (≥3 highlights) should retain at least one of its
 * highlight titles — refine UPDATES, it does not blank-slate. Lenient on purpose (the agent
 * may legitimately reword), so it only fails when nothing recognizable survives.
 */
export function gradePriorContinuity(input: RefineGradeInput): RefineGradeResult {
    const priorTitles = input.prior.highlights.map((h) => normalize(h.title));
    if (priorTitles.length < 3) return mk('priorContinuity', [], 1);
    const refinedTitles = new Set(input.refined.highlights.map((h) => normalize(h.title)));
    const retained = priorTitles.filter((t) => refinedTitles.has(t)).length;
    const score = retained / priorTitles.length;
    const failures = retained === 0 ? ['refine discarded every prior highlight (no continuity)'] : [];
    return mk('priorContinuity', failures, score);
}

export const REFINE_GRADERS = [
    gradeNewRepoCoverage,
    gradeNoDuplicates,
    gradeCaps,
    gradePriorContinuity,
] as const;

export function runRefineGraders(input: RefineGradeInput): RefineGradeReport {
    const results = REFINE_GRADERS.map((g) => g(input));
    return { pass: results.every((r) => r.pass), results };
}
