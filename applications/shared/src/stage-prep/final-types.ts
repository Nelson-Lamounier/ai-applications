/** @format */

/**
 * Final-round result types (shared) — mirror bar-raiser-types.ts.
 *
 * Carried on `InterviewCoachResult` (in this package) as `finalPrep` for the
 * final-round stage: why-this-role framing, mutual-fit talking points,
 * substantive questions to ask, and long-term framing.
 */

/** One mutual-fit talking point + the grounding that backs it. */
export interface FinalTalkingPoint {
  point: string;
  grounding: string;
}

/** One substantive question to ask + its rationale. */
export interface FinalQuestion {
  question: string;
  rationale: string;
}

/** Final-round preparation brief emitted by the coach. */
export interface FinalPrep {
  whyThisRole: string;
  mutualFitTalkingPoints: FinalTalkingPoint[];
  substantiveQuestions: FinalQuestion[];
  longTermFraming: string;
}
