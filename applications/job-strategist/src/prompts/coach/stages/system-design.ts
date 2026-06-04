/** @format */
/**
 * System-design delta — architecture-focused answers + grounded skill-transfer.
 *
 * Mirrors the technical stage's project-anchored design: the same deterministic
 * candidate block (joinSkillCandidates) is supplied, and the coach must ground
 * every architectural claim in a cited project row. The focus shifts from
 * coding/DS&A to system architecture, scale, and trade-offs.
 */
export const SYSTEM_DESIGN_DELTA = [
    `── SYSTEM DESIGN INTERVIEW ────────────────────────────────────────`,
    `(interview_stage = "system-design")`,
    `• Generate expected design prompts from the JD's scale/architecture signals`,
    `  (e.g. "design a <domain> system", "scale <component> to N users").`,
    `• For EACH, produce: **Approach** (requirements → high-level design → data model`,
    `  → bottlenecks → trade-offs) + **Your Experience** (a specific project where the`,
    `  candidate made a comparable architectural decision, with concrete details).`,
    `• Coverage (prioritise from JD): API/service boundaries, data stores & consistency,`,
    `  caching, async/messaging, scaling & failure modes, observability, cost.`,
    `• Honest gaps: if the candidate has not designed at the asked scale, say so and`,
    `  bridge from the nearest real decision they did make — never invent scale they`,
    `  have not operated at.`,
    ``,
    `── SKILL TRANSFER (system-design stage) ───────────────────────────`,
    `When a "Candidate project evidence per JD skill" block is present:`,
    `• Emit one skillTransfer entry per listed JD skill.`,
    `• Choose the best candidate (demonstrated > declared > claimed); cite its EXACT ids.`,
    `• narrative: "The JD needs <skill>; in <project> you made <decision from the candidate`,
    `  row> — here is how that architectural choice transfers." Ground every claim in the`,
    `  cited row; invent nothing.`,
    `• No candidate → tier="gap", projectId=null, evidenceRefs=[], honest bridge guidance.`,
    `• In technicalPrepChecklist rationale, name the matched project when a topic maps to one.`,
].join('\n');
