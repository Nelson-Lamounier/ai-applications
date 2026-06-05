/** @format */
import { mkResult } from '../graders.js';
import type { Grader } from '../graders.js';
import type { FinalPrep, FinalTalkingPoint, FinalQuestion } from '@bedrock/shared';

/**
 * Deterministic anti-generic grader for the final stage (CLAUDE.md §5).
 *
 * String/array checks only — no LLM call — so it runs in CI on every prompt change.
 * It is the prompt-side complement to runtime `validateFinalPrep`: where the validator
 * drops empty talking points/questions, this grader fails the grounding discipline
 * itself — the why-this-role + long-term framing must be present, every substantive
 * question must be specific (no generic blocklist hit), and every talking point must
 * carry the real grounding it rests on.
 */

/** Generic questions a researched candidate would never ask — banned. */
const GENERIC_QUESTION_PATTERNS: RegExp[] = [
    /tell me about (the )?(culture|team|company)/i,
    /what('?s| is) it like/i,
    /day in the life/i,
];

function isBlank(value: string | undefined): boolean {
    return !value || value.trim() === '';
}

function genericHits(question: string): string[] {
    return GENERIC_QUESTION_PATTERNS.filter(re => re.test(question)).map(re => re.source);
}

/** Per-question checks: non-empty, and not a generic blocklist hit. */
function questionFailures(idx: number, q: FinalQuestion): string[] {
    const f: string[] = [];
    const where = `finalPrep.substantiveQuestions[${idx}]`;
    if (isBlank(q.question)) {
        f.push(`${where}: empty question`);
        return f;
    }
    const hits = genericHits(q.question);
    if (hits.length > 0) f.push(`${where}: generic question banned: ${hits.join(', ')}`);
    return f;
}

/** Per-talking-point check: grounding must cite the real fact it rests on. */
function talkingPointFailures(idx: number, tp: FinalTalkingPoint): string[] {
    return isBlank(tp.grounding)
        ? [`finalPrep.mutualFitTalkingPoints[${idx}]: empty grounding`]
        : [];
}

function prepFailures(prep: FinalPrep): string[] {
    const f: string[] = [];
    if (isBlank(prep.whyThisRole)) f.push('finalPrep: empty whyThisRole');
    if (isBlank(prep.longTermFraming)) f.push('finalPrep: empty longTermFraming');
    if (!prep.substantiveQuestions || prep.substantiveQuestions.length === 0) {
        f.push('finalPrep: empty substantiveQuestions');
    } else {
        prep.substantiveQuestions.forEach((q, i) => f.push(...questionFailures(i, q)));
    }
    (prep.mutualFitTalkingPoints ?? []).forEach((tp, i) => f.push(...talkingPointFailures(i, tp)));
    return f;
}

/**
 * Anti-generic grader. Runs only on the final stage; a no-op elsewhere.
 * `stage` is matched on the widened string because 'final' is a dispatch-layer
 * prep stage, not a member of the lifecycle InterviewStage union.
 */
export const finalGrader: Grader = (input, output) => {
    if ((input.stage as string) !== 'final') return mkResult('final', []);
    const prep = output.finalPrep as FinalPrep | undefined;
    if (!prep) return mkResult('final', ['finalPrep: missing']);
    return mkResult('final', prepFailures(prep));
};
