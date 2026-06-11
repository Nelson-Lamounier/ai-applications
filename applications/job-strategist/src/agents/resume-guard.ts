/** @format */
import type { StructuredResumeData } from '@bedrock/shared';

export interface ResumeViolation { code: string; detail: string; }
export interface ResumeGuardCtx {
    targetRole: string;
    leadIdentity: string;
    verifiedEducation: string[];
    archetypeSkillLead: string;
}

const GAP_RE = /falls?\s+short|\b\d{1,2}\s*years?\b[^.]{0,40}\b(?:short|threshold|bar|requirement|fall)|do(?:es)?\s*not\s+yet\s+have/i;

/**
 * Generic stop-words that appear in many identities and are not differentiating
 * (e.g. "engineer", "builds", "years", "with", "who").
 */
const GENERIC_TOKENS = new Set(['engineer', 'builds', 'build', 'years', 'with', 'from', 'that', 'this', 'have', 'been', 'into', 'your', 'their', 'where', 'what', 'will', 'more', 'over', 'about', 'some', 'when', 'than', 'like']);

/**
 * Returns the distinctive lead tokens from the identity string — words that
 * identify the archetype cluster (e.g. "support", "production") — by taking
 * the first token that is not in GENERIC_TOKENS.
 */
function leadClusterTokens(leadIdentity: string): string[] {
    const all = leadIdentity.toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 3);
    return all.filter((t) => !GENERIC_TOKENS.has(t));
}

export function validateResume(resume: StructuredResumeData, ctx: ResumeGuardCtx): ResumeViolation[] {
    const out: ResumeViolation[] = [];
    const title = resume.profile.title.trim();

    const hasSeparator = /[·—|]/.test(title);
    const employmentTitles = new Set(resume.experience.map((e) => e.title.toLowerCase().trim()));
    if (title && (!hasSeparator || employmentTitles.has(title.toLowerCase()))) {
        out.push({ code: 'headline_is_title', detail: `profile.title "${title}" reads as a job-title claim, not a positioning headline.` });
    }

    const summary = resume.summary.trim();
    const firstSentence = summary.split(/(?<=[.!?])\s/)[0]?.toLowerCase() ?? '';
    const tokens = leadClusterTokens(ctx.leadIdentity);
    if (summary && tokens.length > 0 && !tokens.some((t) => firstSentence.includes(t))) {
        out.push({ code: 'summary_wrong_cluster', detail: 'Summary opener does not lead with the archetype lead-identity differentiator.' });
    }

    if (GAP_RE.test(summary)) {
        out.push({ code: 'summary_names_gap', detail: 'Summary names/concedes the experience gap.' });
    }

    const verifiedLower = new Set(ctx.verifiedEducation.map((v) => v.toLowerCase()));
    for (const ed of resume.education) {
        const deg = ed.degree.toLowerCase();
        if (deg && !Array.from(verifiedLower).some((v) => v.includes(deg) || deg.includes(v))) {
            out.push({ code: 'education_mismatch', detail: `Education "${ed.degree}" not in the verified facts.` });
            break;
        }
    }

    if (ctx.archetypeSkillLead) {
        const firstCat = (resume.skills[0]?.category ?? '').toLowerCase();
        if (firstCat && firstCat !== ctx.archetypeSkillLead.toLowerCase()) {
            out.push({ code: 'skills_lead_mismatch', detail: `First skill group "${resume.skills[0]?.category}" is not the archetype lead "${ctx.archetypeSkillLead}".` });
        }
    }

    return out;
}
