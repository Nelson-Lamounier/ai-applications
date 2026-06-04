/** @format */

/** A single concern row from the system_design_concerns ontology (migration 065). */
export interface SystemDesignConcern {
  readonly concernId: string;
  readonly category: string;
  readonly concernQuestion: string;
  readonly whyInterviewersAsk: string;
  readonly detectionSignals: string[];
  readonly implementationPatterns: Array<{ name: string; strengths: string[]; gotchas: string[] }>;
  readonly followUpQuestions: string[];
  readonly gapSignals: string[];
  readonly jdSignalKeywords: string[];
  readonly importance: number;
}

/** Evidence pointer cited from real project rows (same shape as skill-transfer). */
export interface ConcernEvidenceRef {
  readonly source: string; // 'component' | 'decision' | 'stack_item' | 'tag' | 'tech_evidence' | 'dsa_evidence'
  readonly id: string;
  readonly label: string;
  readonly fileLine?: string;
}

export type ConcernStrength = 'strong' | 'partial' | 'none';

/** Per-concern detection result — produced deterministically, never by the model. */
export interface DetectedConcern {
  readonly concernId: string;
  readonly category: string;
  readonly strength: ConcernStrength;
  readonly evidenceRefs: ConcernEvidenceRef[];
  readonly relevantToJd: boolean;
}

/** Coverage map + alignment count for the workspace header. */
export interface ConcernCoverage {
  readonly detected: DetectedConcern[];
  readonly relevantTotal: number;
  readonly relevantAddressed: number;
}

export type FollowUpStatus = 'addressed' | 'partial' | 'gap';

export interface SystemDesignFollowUp {
  readonly question: string;
  readonly status: FollowUpStatus;
  readonly framing: string;
}

/** One walkthrough card emitted by the coach (prose) + grounded evidence (from detection). */
export interface SystemDesignWalkthroughCard {
  readonly concernId: string;
  readonly concernQuestion: string;
  readonly whyItMatters: string;
  readonly evidenceRefs: ConcernEvidenceRef[];
  readonly choiceMade: string | null;
  readonly articulation: string;
  readonly followUps: SystemDesignFollowUp[];
  readonly gapGuidance: string | null;
}
