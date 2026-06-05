/** @format */
import { mkResult } from '../graders.js';
import type { Grader } from '../graders.js';
import type { BarRaiserPrinciple, BarRaiserStory } from '@bedrock/shared';

/**
 * Deterministic honesty-calibration grader for the bar-raiser stage (CLAUDE.md §5).
 *
 * String/array checks only — no LLM call — so it runs in CI on every prompt change.
 * It is the prompt-side complement to runtime `validateBarRaiserWalkthrough`: where
 * the validator drops ungrounded stories, this grader fails the calibration discipline
 * itself — every story must carry honest calibration, must be grounded, and must NOT
 * inflate solo/ungrounded work into team-leadership claims; every gap must be framed.
 */

/** Inflation patterns that over-claim team leadership — banned on solo/ungrounded stories. */
const INFLATION_PATTERNS: RegExp[] = [
    /\bled a team\b/i,
    /\bi led the team\b/i,
    /\bmanaged a team\b/i,
    /\bbuilt a team\b/i,
    /\bhired a team\b/i,
    /\bgrew the team\b/i,
];

/** Prose fields a Bar Raiser would probe — where inflation would actually be claimed. */
function storyProse(s: BarRaiserStory): string {
    return [s.title, s.situation, s.task, s.action, s.result].join(' ');
}

function inflationHits(text: string): string[] {
    return INFLATION_PATTERNS.filter(re => re.test(text)).map(re => re.source);
}

/** Per-story calibration checks: non-empty calibration, grounded refs, no inflation. */
function storyFailures(principleId: string, idx: number, s: BarRaiserStory): string[] {
    const f: string[] = [];
    const where = `${principleId}.stories[${idx}]`;
    if (!s.honestyCalibration || s.honestyCalibration.trim() === '') {
        f.push(`${where}: empty honestyCalibration`);
    }
    if (!s.seniorityNote || s.seniorityNote.trim() === '') {
        f.push(`${where}: empty seniorityNote`);
    }
    if (s.evidenceRefs.length === 0) {
        f.push(`${where}: story has no evidenceRefs (must cite grounded evidence)`);
    }
    // Inflation language is only a failure when the calibration didn't explicitly
    // disclaim it. The differentiator is honest framing, so allow the word inside
    // the calibration note itself (e.g. "NOT 'I led a team'") but never in the story.
    const hits = inflationHits(storyProse(s));
    if (hits.length > 0) f.push(`${where}: inflation language in story prose: ${hits.join(', ')}`);
    return f;
}

/** Per-principle card checks. */
function cardFailures(card: BarRaiserPrinciple): string[] {
    const f: string[] = [];
    if (card.coverage === 'none') {
        if (card.stories.length > 0) f.push(`${card.principleId}: coverage=none must have no stories`);
        if (!card.gapGuidance || card.gapGuidance.trim() === '') {
            f.push(`${card.principleId}: gap card (coverage=none) must have gapGuidance`);
        }
        return f;
    }
    if (card.coverage === 'partial' && (!card.gapGuidance || card.gapGuidance.trim() === '')) {
        f.push(`${card.principleId}: partial coverage must carry gapGuidance`);
    }
    if (card.coverage === 'strong' && card.stories.length === 0) {
        f.push(`${card.principleId}: coverage=strong must have at least one grounded story`);
    }
    card.stories.forEach((s, i) => f.push(...storyFailures(card.principleId, i, s)));
    return f;
}

/**
 * Honesty-calibration grader. Runs only on the bar-raiser stage; a no-op elsewhere.
 * `stage` is matched on the widened string because 'bar-raiser' is a dispatch-layer
 * prep stage, not a member of the lifecycle InterviewStage union.
 */
export const barRaiserGrader: Grader = (input, output) => {
    if ((input.stage as string) !== 'bar-raiser') return mkResult('bar-raiser', []);
    const cards = (output.barRaiserWalkthrough ?? []) as BarRaiserPrinciple[];
    const failures = cards.flatMap(cardFailures);
    return mkResult('bar-raiser', failures);
};
