/**
 * @format
 * User-message builder for the dedicated cover-letter agent.
 *
 * Assembles the Research Brief essentials (target role/company, company
 * problem), the achievement evidence, the Candidate Contact block (VERBATIM
 * signoff source), an optional years-gap framing line, Profile Intelligence,
 * and the assembled resume body as the echo source -- the letter's lead must
 * echo the resume's strongest JD-relevant achievement, per the persona
 * contract in content/strategist/cover-letter-agent.md.
 *
 * BATCH-2 DEPENDENCY: `resumeBody` is the FINISHED StructuredResumeData --
 * summary, experience[].highlights, and projects[].highlights already
 * authored by the dedicated summary/experience/projects agents (this agent
 * is the last of the four writer-split passes and needs their combined
 * output, not raw evidence). Until the batch-2 pipeline splice assembles
 * that body and passes it here, omit `resumeBody` -- the echo section is
 * skipped and the persona falls back to the achievement-evidence block for
 * its lead.
 */
import type { StructuredResumeData } from '@bedrock/shared';

export interface CoverLetterMessageInput {
    readonly targetRole: string;
    readonly targetCompany: string;
    readonly companyProblem?: string;
    readonly achievementEvidence?: string;
    /** VERBATIM source for signoff.name/email/linkedin/github -- see the persona's SIGNOFF rule. */
    readonly candidateContact?: string;
    readonly yearsGapFraming?: string;
    readonly profileIntelligence?: string;
    /** The assembled resume body (echo source) -- see the batch-2 dependency note above. */
    readonly resumeBody?: StructuredResumeData;
}

/** Target role/company + the company problem -- always present, problem is optional. */
function researchBriefSection(m: CoverLetterMessageInput): string[] {
    const out = [`Target role: ${m.targetRole}`, `Target company: ${m.targetCompany}`];
    if (m.companyProblem?.trim()) {
        out.push('', '### The Problem This Role Solves', m.companyProblem.trim());
    }
    return out;
}

/** Achievement & impact evidence -- P1/P2 material. */
function achievementSection(m: CoverLetterMessageInput): string[] {
    if (!m.achievementEvidence?.trim()) return [];
    return [
        '',
        '### Achievement & Impact Evidence (lead with a challenge overcome; surface decision impacts relevant to the JD)',
        m.achievementEvidence.trim(),
    ];
}

/** Candidate contact -- the VERBATIM signoff source. */
function candidateContactSection(m: CoverLetterMessageInput): string[] {
    if (!m.candidateContact?.trim()) return [];
    return ['', '### Candidate Contact (VERBATIM source for the signoff)', m.candidateContact.trim()];
}

/** Years-gap framing -- paraphrase in first person, never verbatim. */
function yearsGapSection(m: CoverLetterMessageInput): string[] {
    if (!m.yearsGapFraming?.trim()) return [];
    return ['', `YEARS GAP FRAMING (paraphrase this true relevant-experience framing in first person, never verbatim): ${m.yearsGapFraming.trim()}`];
}

/** Profile Intelligence -- positioning source, code-grounded. */
function profileIntelligenceSection(m: CoverLetterMessageInput): string[] {
    if (!m.profileIntelligence?.trim()) return [];
    return ['', '### Profile Intelligence (code-grounded positioning source)', m.profileIntelligence.trim()];
}

/** Experience entries, rendered as title @ company (period) + highlights. */
function experienceLines(experience: StructuredResumeData['experience']): string[] {
    const out: string[] = ['### Experience'];
    for (const e of experience) {
        out.push(`- ${e.title} @ ${e.company} (${e.period})`);
        for (const h of e.highlights ?? []) out.push(`  - ${h}`);
    }
    return out;
}

/** Project entries, rendered as name + highlights. */
function projectLines(projects: StructuredResumeData['projects']): string[] {
    const out: string[] = ['### Projects'];
    for (const p of projects) {
        out.push(`- ${p.name}`);
        for (const h of p.highlights ?? []) out.push(`  - ${h}`);
    }
    return out;
}

/** The finished resume body -- the echo source for the letter's lead achievement. */
function resumeBodyEchoSection(m: CoverLetterMessageInput): string[] {
    const body = m.resumeBody;
    if (!body) return [];

    const parts: string[] = [];
    if (body.summary?.trim()) parts.push('### Summary', body.summary.trim());
    if (body.experience.length > 0) parts.push(...experienceLines(body.experience));
    if (body.projects.length > 0) parts.push(...projectLines(body.projects));
    if (parts.length === 0) return [];

    return ['', "## Resume body (echo source -- echo this body's strongest JD-relevant achievement in the letter's lead)", ...parts];
}

/** Focused user message for the cover-letter agent -- research essentials,
 *  evidence, candidate contact, years-gap framing, profile intelligence, and
 *  the resume-body echo source. Every optional section omits itself when empty. */
export function buildCoverLetterMessage(m: CoverLetterMessageInput): string {
    return [
        ...researchBriefSection(m),
        ...achievementSection(m),
        ...candidateContactSection(m),
        ...yearsGapSection(m),
        ...profileIntelligenceSection(m),
        ...resumeBodyEchoSection(m),
    ].join('\n');
}
