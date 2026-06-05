/** @format */

/**
 * Bar Raiser result types (shared) — mirror system-design-concerns-types.ts.
 *
 * Structurally identical to the detection-side types in
 * `@bedrock/job-strategist`'s lib/bar-raiser-grounding.ts; declared here so the
 * `InterviewCoachResult` (in this package) can carry `barRaiserWalkthrough`
 * without job-strategist→shared importing in the wrong direction.
 */

export type PrincipleCoverageStrength = 'strong' | 'partial' | 'none';

/** Evidence pointer cited from real project rows (same shape as concern/skill-transfer refs). */
export interface BarRaiserEvidenceRef {
  readonly source: string;
  readonly id: string;
  readonly label: string;
  readonly fileLine?: string;
}

/** One STAR story emitted by the coach (prose) + grounded evidence (from detection). */
export interface BarRaiserStory {
  readonly title: string;
  readonly situation: string;
  readonly task: string;
  readonly action: string;
  readonly result: string;
  readonly evidenceRefs: BarRaiserEvidenceRef[];
  readonly honestyCalibration: string;
  readonly seniorityNote: string;
}

export interface BarRaiserProbingQuestion {
  readonly question: string;
  readonly framing: string;
}

/** Per-principle deterministic detection result (mirrors DetectedConcern). */
export interface PrincipleCoverage {
  readonly principleId: string;
  readonly coverage: PrincipleCoverageStrength;
  readonly evidenceRefs: BarRaiserEvidenceRef[];
  readonly relevantToJd: boolean;
}

/** Coverage map + alignment count for the workspace header (mirrors ConcernCoverage). */
export interface BarRaiserCoverage {
  readonly detected: PrincipleCoverage[];
  readonly relevantTotal: number;
  readonly relevantAddressed: number;
}

/** One principle card emitted by the coach + sanitised by validateBarRaiserWalkthrough. */
export interface BarRaiserPrinciple {
  readonly principleId: string;
  readonly principleName: string;
  readonly interpretation: string;
  readonly coverage: PrincipleCoverageStrength;
  readonly stories: BarRaiserStory[];
  readonly probingQuestions: BarRaiserProbingQuestion[];
  readonly gapGuidance: string | null;
}
