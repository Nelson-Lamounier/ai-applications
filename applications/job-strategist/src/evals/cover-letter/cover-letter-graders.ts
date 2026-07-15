/**
 * @format
 * Cover-letter-agent per-phase eval - offline structural graders.
 *
 * These DELEGATE to `agents/quality/cover-letter-guard.ts`'s exported rule
 * predicates so "eval says good" and "guard accepts" can never drift. Five
 * predicates: paragraph count, signoff completeness, em-dash ban,
 * tenure-conditional, and first-person voice. The last two ALREADY ran inside
 * the guard's bundled `validateCoverLetterNarrative` / `validateCoverLetter`;
 * the first three had no standalone predicate before this task -- see the
 * "STANDALONE RULE PREDICATES" section added to cover-letter-guard.ts. No
 * Bedrock call - pure, deterministic checks against a fixed CoverLetterEvalInput.
 */
import type { CoverLetter } from '@bedrock/shared';
import {
    checkParagraphCount,
    checkSignoffComplete,
    checkNoEmDash,
    checkTenureConditional,
    checkThirdPersonVoice,
    type CoverLetterViolation,
} from '../../agents/quality/cover-letter-guard.js';
import { mkResult, type GraderResult } from '../graders.js';

/** The exact letter the cover-letter phase produces + the JD context it was graded against. */
export interface CoverLetterEvalInput {
    readonly letter: CoverLetter;
    /** false => the JD sets no years requirement; tenure mentions become a violation. */
    readonly hasYearsBar: boolean;
}

function toFailures(violations: readonly CoverLetterViolation[]): string[] {
    return violations.map((v) => `${v.code}: ${v.detail}`);
}

/** Exactly 3 paragraphs -- delegates to checkParagraphCount. */
export function paragraphCountGrader(i: CoverLetterEvalInput): GraderResult {
    return mkResult('paragraphCount', toFailures(checkParagraphCount(i.letter)));
}

/** Every signoff field non-empty -- delegates to checkSignoffComplete. */
export function signoffCompleteGrader(i: CoverLetterEvalInput): GraderResult {
    return mkResult('signoffComplete', toFailures(checkSignoffComplete(i.letter)));
}

/** No em-dash anywhere -- delegates to checkNoEmDash. */
export function noEmDashGrader(i: CoverLetterEvalInput): GraderResult {
    return mkResult('noEmDash', toFailures(checkNoEmDash(i.letter)));
}

/** Tenure-conditional -- delegates to checkTenureConditional. Vacuous when hasYearsBar !== false. */
export function tenureConditionalGrader(i: CoverLetterEvalInput): GraderResult {
    return mkResult('tenureConditional', toFailures(checkTenureConditional(i.letter, i.hasYearsBar)));
}

/** First-person voice -- delegates to checkThirdPersonVoice. */
export function thirdPersonGrader(i: CoverLetterEvalInput): GraderResult {
    return mkResult('thirdPerson', toFailures(checkThirdPersonVoice(i.letter)));
}

/** All structural graders, in display order. */
export const COVER_LETTER_GRADERS = [
    paragraphCountGrader,
    signoffCompleteGrader,
    noEmDashGrader,
    tenureConditionalGrader,
    thirdPersonGrader,
] as const;

/** Run every grader; overall pass = all pass. */
export function runCoverLetterGraders(i: CoverLetterEvalInput): { pass: boolean; results: GraderResult[] } {
    const results = COVER_LETTER_GRADERS.map((g) => g(i));
    return { pass: results.every((r) => r.pass), results };
}
