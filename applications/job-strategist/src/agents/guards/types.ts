/**
 * @format
 * Shared types for the resume-guard rule modules.
 *
 * Part of the guards/ decomposition: resume-guard.ts grew past 1,100 lines and
 * its rules repeatedly slipped during review (the projects-highlights saga
 * lived in this blast radius). Each rule family now owns a module; the
 * resume-guard.ts facade re-exports everything so consumers are unchanged.
 */

export interface ResumeViolation { code: string; detail: string; }
export interface VerifiedEmployer { readonly name: string; readonly facts: string; }
export interface ResumeGuardCtx {
    targetRole: string;
    leadIdentity: string;
    verifiedEducation: string[];
    archetypeSkillLead: string;
    /** The JD's company problem — the summary's mandatory bridge target. */
    companyProblem?: string;
    /** The JD's company name — the bridge sentence's attribution anchor. */
    targetCompany?: string;
    /** Documented project pitches — the opening beat a project description must use. */
    projectPitches?: ReadonlyArray<{ name: string; pitch: string }>;
    /** JD required skills — with targetRole, the vocabulary the JD-echo fidelity gate screens for. */
    jdRequiredSkills?: ReadonlyArray<string>;
    /** Verified certifications (name + date string) — years are enforced, not trusted. */
    verifiedCertifications?: ReadonlyArray<{ name: string; date: string }>;
    /** Career-history employers + their verified highlight facts — the attribution boundary. */
    verifiedEmployers?: ReadonlyArray<VerifiedEmployer>;
}
