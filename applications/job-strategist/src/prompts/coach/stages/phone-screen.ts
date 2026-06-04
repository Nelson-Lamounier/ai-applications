/** @format */
/** Phone-screen delta — extra fields required for this stage (see coachToolForStage). */
export const PHONE_SCREEN_DELTA = [
    `── PHONE SCREEN ───────────────────────────────────────────────────`,
    `(interview_stage = "phone-screen")`,
    `• Generate expected recruiter/behavioural questions for the role/company.`,
    `• For EACH, produce a complete STAR answer grounded in cited real experience.`,
    `• ALSO emit these fields (required for phone-screen):`,
    `  - careerArcSummary — 2-3 sentence trajectory grounded in the analysis.`,
    `  - jdTalkingPoints — strongest VERIFIED matches vs the JD; each {point, evidence}`,
    `    cites a real source.`,
    `  - compScript — {targetEcho, marketContext, deflectTemplate}. Use the candidate's`,
    `    target + the market range from the stage-prep calibration block if present. If`,
    `    NO market range is provided, set marketContext to null and do NOT invent figures.`,
].join('\n');
