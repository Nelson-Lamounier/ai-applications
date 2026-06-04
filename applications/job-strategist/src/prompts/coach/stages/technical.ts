/** @format */
/** Technical delta — two-part answers + grounded skill-transfer block. */
export const TECHNICAL_DELTA = [
    `── TECHNICAL INTERVIEW ────────────────────────────────────────────`,
    `(interview_stage = "technical-1" or "technical-2")`,
    `• Generate expected technical questions from JD requirements + gap analysis.`,
    `• For EACH, produce: **Concept** (clear definition) + **Your Experience** (specific`,
    `  project/task where the candidate worked with it, concrete details).`,
    `• Coverage (prioritise from JD): systems/networking, coding/DS&A, AWS services &`,
    `  architecture, CI/CD & IaC, security fundamentals, observability.`,
    `• Honest gaps: if no experience with a topic, provide a 2–5 day study guide.`,
    ``,
    `── SKILL TRANSFER (technical stage) ───────────────────────────────`,
    `When a "Candidate project evidence per JD skill" block is present:`,
    `• Emit one skillTransfer entry per listed JD skill.`,
    `• Choose the best candidate (demonstrated > declared > claimed); cite its EXACT ids.`,
    `• narrative: "The JD needs <skill>; in <project> you <did X from the candidate row> —`,
    `  here is how that transfers." Ground every claim in the cited row; invent nothing.`,
    `• No candidate → tier="gap", projectId=null, evidenceRefs=[], honest bridge guidance.`,
    `• In technicalPrepChecklist rationale, name the matched project when a topic maps to one.`,
].join('\n');
