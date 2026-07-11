/**
 * @format
 * Summary-agent (B1) per-phase eval - offline structural graders.
 *
 * These reuse the exact predicates the runtime resume guard applies
 * (`namesGap`, `numbersIn`) so "eval says good" and "guard accepts" can never
 * drift: a summary that would fail here would also fail the live guard, and
 * vice versa. No Bedrock call - pure, deterministic checks against a fixed
 * SummaryEvalInput.
 */
import type { StructuredResumeData } from '@bedrock/shared';
import { namesGap } from '../../agents/quality/guards/summary-rules.js';
import { numbersIn } from '../../agents/quality/guards/text.js';
import { mkResult, type GraderResult } from '../graders.js';

/** The exact input the summary phase produces + the context it was graded against. */
export interface SummaryEvalInput {
    readonly summary: string;
    readonly body: StructuredResumeData;
    readonly fitSummary: string;
    readonly gapSkills: string[];
    readonly targetCompany: string;
}

/** No gap/shortfall language - reuses the runtime guard's own predicate. */
export function noGapGrader(i: SummaryEvalInput): GraderResult {
    return mkResult('noGap', namesGap(i.summary) ? ['summary names a gap/shortfall (guard would reject)'] : []);
}

/**
 * Altitude: the summary POSITIONS, bullets PROVE - a summary number that also
 * appears in an experience/project highlight is a restated inventory, not a
 * positioning statement.
 */
export function altitudeGrader(i: SummaryEvalInput): GraderResult {
    const summaryNums = numbersIn(i.summary);
    const bulletNums = new Set<string>();
    for (const e of i.body.experience) for (const h of e.highlights) for (const n of numbersIn(h)) bulletNums.add(n);
    for (const p of i.body.projects) for (const h of p.highlights ?? []) for (const n of numbersIn(h)) bulletNums.add(n);
    const shared = [...summaryNums].filter((n) => bulletNums.has(n));
    return mkResult('altitude', shared.map((n) => `number "${n}" shared between summary and a bullet`));
}

/** Summary must stay under the length budget of a positioning statement. */
export function wordCountGrader(i: SummaryEvalInput): GraderResult {
    const words = i.summary.trim().split(/\s+/).filter(Boolean).length;
    return mkResult('wordCount', words > 100 ? [`summary is ${words} words (>100)`] : []);
}

const BANNED = [/this role exists to/i, /portfolio[- ]scale/i, /they need\b/i];

/** Banned phrases + the target company name must never appear in the summary. */
export function bansGrader(i: SummaryEvalInput): GraderResult {
    const failures: string[] = [];
    if (i.targetCompany && new RegExp(`\\b${i.targetCompany.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(i.summary)) {
        failures.push('summary names the target company');
    }
    for (const re of BANNED) if (re.test(i.summary)) failures.push(`banned phrase: ${re}`);
    return mkResult('bans', failures);
}

/** The summary must not claim any of the identified gap skills. */
export function gapClaimGrader(i: SummaryEvalInput): GraderResult {
    const failures = i.gapSkills
        .filter((s) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(i.summary))
        .map((s) => `summary claims a gap skill: ${s}`);
    return mkResult('gapClaim', failures);
}

/** All structural graders, in display order. */
export const SUMMARY_GRADERS = [noGapGrader, altitudeGrader, wordCountGrader, bansGrader, gapClaimGrader] as const;

/** Run every grader; overall pass = all pass. */
export function runSummaryGraders(i: SummaryEvalInput): { pass: boolean; results: GraderResult[] } {
    const results = SUMMARY_GRADERS.map((g) => g(i));
    return { pass: results.every((r) => r.pass), results };
}
