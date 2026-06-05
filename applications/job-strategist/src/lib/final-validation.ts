/**
 * @format
 * Final-round prep hygiene.
 *
 * Pure pass after the coach emits `FinalPrep`: drop mutual-fit talking points
 * with an empty/whitespace `point` and substantive questions with an
 * empty/whitespace `question`. Prose fields (`whyThisRole`, `longTermFraming`)
 * are kept as-is. `undefined` in → `undefined` out, so callers can pipe an
 * optional `finalPrep` straight through.
 */
import type { FinalPrep, FinalTalkingPoint, FinalQuestion } from '@bedrock/shared';

const isNonEmpty = (value: string): boolean => value.trim().length > 0;

export function validateFinalPrep(prep: FinalPrep | undefined): FinalPrep | undefined {
  if (prep === undefined) return undefined;

  const mutualFitTalkingPoints: FinalTalkingPoint[] = prep.mutualFitTalkingPoints.filter((tp) =>
    isNonEmpty(tp.point),
  );
  const substantiveQuestions: FinalQuestion[] = prep.substantiveQuestions.filter((q) =>
    isNonEmpty(q.question),
  );

  return { ...prep, mutualFitTalkingPoints, substantiveQuestions };
}
