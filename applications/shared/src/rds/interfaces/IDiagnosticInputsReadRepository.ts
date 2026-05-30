/** @format */
export interface KbStats {
  readonly projectRepoCount:     number;
  readonly reposWithHighKbScore: number;   // count where kb_quality_score >= KB_SCORE_THRESHOLD (0.6)
  readonly avgRetrievalScore:    number | null;
}
export interface ResumeEntryCounts {
  readonly skills:     number;
  readonly experience: number;
  readonly projects:   number;
}
export interface DiagnosticInputs {
  readonly kbStats:           KbStats;
  readonly resumePresent:     boolean;
  readonly resumeEntryCounts: ResumeEntryCounts;
}

export interface IDiagnosticInputsReadRepository {
  /** Reads the small projection the deterministic Diagnostic formula needs.
   *  Returns honest zeros / null / false for legitimately empty data — that
   *  is the truthful current state, NOT a failure. THROWS only on real
   *  database / RLS errors. */
  getDiagnosticInputs(userId: string): Promise<DiagnosticInputs>;
}
