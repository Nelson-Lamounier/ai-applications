/** @format */
export interface ResumeSkillGroup   { readonly category: string; readonly skills: ReadonlyArray<string> }
export interface ResumeExperienceEntry { readonly company: string; readonly title: string; readonly highlights: ReadonlyArray<string> }
export interface ResumeProjectEntry  { readonly name: string; readonly description: string }
export interface ResumeForReconciliation {
  readonly skills:     ReadonlyArray<ResumeSkillGroup>;
  readonly experience: ReadonlyArray<ResumeExperienceEntry>;
  readonly projects:   ReadonlyArray<ResumeProjectEntry>;
}
export interface ICareerHistoryReadRepository {
  /** Reads the user's structured résumé (skill/experience/project rows) from
   *  user_career_history. Returns undefined when no such rows exist (no
   *  résumé imported). Never throws on shape drift — maps defensively. */
  getResumeForReconciliation(userId: string): Promise<ResumeForReconciliation | undefined>;
}
