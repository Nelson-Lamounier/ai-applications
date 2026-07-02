/** @format */
import { runAgent, log, normalizeProse } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext, StructuredResumeData } from '@bedrock/shared';
import { ResumeRewriteSchema, buildEmitResumeTool } from './resume-tool-schema.js';

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

/** Job-title nouns that must not appear in a positioning headline's lead segment. */
const TITLE_NOUNS = new Set(['engineer', 'engineering', 'associate', 'analyst', 'manager', 'developer', 'specialist', 'lead', 'architect', 'consultant', 'administrator', 'coordinator', 'technician', 'officer', 'director', 'assistant', 'representative', 'agent', 'scientist']);

/** A "Selected work"/GitHub highlight must not sit under a support/customer/QA role. */
const SUPPORT_ROLE_RE = /support|customer|service|associate|quality assurance|\bqa\b|help\s?desk|technician/i;
const SELECTED_WORK_RE = /selected work|github\.com/i;

/**
 * Returns the distinctive lead tokens from the identity string — words that
 * identify the archetype cluster (e.g. "support", "production") — by taking
 * the first token that is not in GENERIC_TOKENS.
 */
function leadClusterTokens(leadIdentity: string): string[] {
    const all = leadIdentity.toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 3);
    return all.filter((t) => !GENERIC_TOKENS.has(t));
}

/** Returns the support/customer role title whose highlights hold a Selected-work/GitHub line, else null. */
function findMisplacedSelectedWork(resume: StructuredResumeData): string | null {
    for (const e of resume.experience ?? []) {
        if (SUPPORT_ROLE_RE.test(e.title) && (e.highlights ?? []).some((h) => SELECTED_WORK_RE.test(h))) {
            return e.title;
        }
    }
    return null;
}

export function validateResume(resume: StructuredResumeData, ctx: ResumeGuardCtx): ResumeViolation[] {
    const out: ResumeViolation[] = [];
    const title = resume.profile.title.trim();

    const hasSeparator = /[·—|]/.test(title);
    const employmentTitles = new Set(resume.experience.map((e) => e.title.toLowerCase().trim()));
    const leadSeg = title.split(/[·—|]/)[0].trim().toLowerCase();
    const hasTitleNoun = leadSeg.split(/\s+/).some((w) => TITLE_NOUNS.has(w));
    if (title && (!hasSeparator || employmentTitles.has(title.toLowerCase()) || hasTitleNoun)) {
        out.push({ code: 'headline_is_title', detail: `profile.title "${title}" reads as a job-title claim — it must be a descriptive domain/capability headline with NO job-title noun (Engineer, Associate, Analyst, Manager, Developer, Specialist, Lead, Architect…).` });
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

    const misplaced = findMisplacedSelectedWork(resume);
    if (misplaced) {
        out.push({ code: 'selected_work_misplaced', detail: `"Selected work"/GitHub links appear under the support/customer role "${misplaced}" — they must sit under a builder/engineering role (e.g. Freelance / Cloud & DevOps), or a Projects section.` });
    }

    return out;
}

// =============================================================================
// SCOPED-CLAIM ENFORCEMENT (deterministic)
// =============================================================================

/**
 * Evidence metrics that carry a mandatory scope qualifier. A claim using the
 * metric WITHOUT its qualifier overstates scope (the exact failure the
 * anti-fabrication positioning exists to prevent). Enforcement is section-
 * aware: sections that allow qualifiers get the qualifier appended; sections
 * where qualifiers are banned (summary, skills, projects) lose the metric.
 */
export interface ScopedClaim {
    /** Topic words that identify the claim in prose (with metricCore in the same string). */
    readonly context: RegExp;
    /** The metric's numeric core (e.g. inside a parenthetical). */
    readonly metricCore: RegExp;
    /** Present ⇒ the claim is properly scoped. */
    readonly qualifier: RegExp;
    /** Text appended when qualifying is allowed. */
    readonly qualifierText: string;
    readonly label: string;
}

export const SCOPED_CLAIMS: readonly ScopedClaim[] = [
    {
        context:       /cach\w*|prompt/i,
        metricCore:    /~?\s*90\s*%/,
        qualifier:     /writer\s+lambda/i,
        qualifierText: '(Writer Lambda)',
        label:         'prompt-cache cost reduction',
    },
];

function isUnqualified(text: string, claim: ScopedClaim): boolean {
    return claim.metricCore.test(text) && claim.context.test(text) && !claim.qualifier.test(text);
}

/** Append the scope qualifier to the sentence carrying the metric. */
function qualifyClaim(text: string, claim: ScopedClaim): string {
    return text
        .split(/(?<=[.!?])\s+/)
        .map((s) => {
            if (!isUnqualified(s, claim)) return s;
            const trimmed = s.replace(/([.!?])$/, '');
            const punct = s.endsWith(trimmed) ? '' : s.slice(trimmed.length);
            return `${trimmed} ${claim.qualifierText}${punct}`;
        })
        .join(' ');
}

/**
 * Remove an unqualified scoped metric from prose: first drop a parenthetical
 * carrying it, then (if it survives outside parentheses) drop the sentence.
 */
function stripClaimFromProse(text: string, claim: ScopedClaim): string {
    const withoutParen = text.replace(/\s*\([^)]*\)/g, (m) => (claim.metricCore.test(m) ? '' : m));
    if (!isUnqualified(withoutParen, claim)) return withoutParen.trim();
    return withoutParen
        .split(/(?<=[.!?])\s+/)
        .filter((s) => !isUnqualified(s, claim))
        .join(' ')
        .trim();
}

function enforceClaimOnSkills(resume: StructuredResumeData, claim: ScopedClaim): StructuredResumeData {
    if (!Array.isArray(resume.skills)) return resume;
    const skills = resume.skills.map((group) => ({
        ...group,
        skills: (group.skills ?? [])
            .map((s) => (isUnqualified(s, claim) ? stripClaimFromProse(s, claim) : s))
            .filter((s) => s.length > 0 && !isUnqualified(s, claim)),
    }));
    return { ...resume, skills };
}

function enforceClaimOnHighlights(resume: StructuredResumeData, claim: ScopedClaim): StructuredResumeData {
    if (!Array.isArray(resume.experience)) return resume;
    const experience = resume.experience.map((e) => ({
        ...e,
        highlights: (e.highlights ?? []).map((h) => (isUnqualified(h, claim) ? qualifyClaim(h, claim) : h)),
    }));
    const keyAchievements = Array.isArray(resume.keyAchievements)
        ? resume.keyAchievements.map((k) => (
            typeof k.achievement === 'string' && isUnqualified(k.achievement, claim)
                ? { ...k, achievement: qualifyClaim(k.achievement, claim) }
                : k))
        : resume.keyAchievements;
    return { ...resume, experience, keyAchievements };
}

function enforceClaimOnProse(resume: StructuredResumeData, claim: ScopedClaim): StructuredResumeData {
    const summary = typeof resume.summary === 'string' && isUnqualified(resume.summary, claim)
        ? stripClaimFromProse(resume.summary, claim)
        : resume.summary;
    const projects = Array.isArray(resume.projects)
        ? resume.projects.map((p) => (
            typeof p.description === 'string' && isUnqualified(p.description, claim)
                ? { ...p, description: stripClaimFromProse(p.description, claim) }
                : p))
        : resume.projects;
    return { ...resume, summary, projects };
}

/**
 * There is NO separate Key Achievements section on the resume — achievement
 * material integrates into experience lead bullets and the summary metric
 * (prompt rule). When the model emits the section anyway, drop it and scrub
 * `sectionOrder`; the violation code keeps the event observable.
 */
export function dropKeyAchievementsSection(resume: StructuredResumeData): { resume: StructuredResumeData; violations: ResumeViolation[] } {
    const emitted = Array.isArray(resume.keyAchievements) && resume.keyAchievements.length > 0;
    const inOrder = Array.isArray(resume.sectionOrder) && resume.sectionOrder.includes('keyAchievements');
    if (!emitted && !inOrder) return { resume, violations: [] };
    const out: StructuredResumeData = {
        ...resume,
        keyAchievements: [],
        ...(Array.isArray(resume.sectionOrder)
            ? { sectionOrder: resume.sectionOrder.filter((k) => k !== 'keyAchievements') }
            : {}),
    };
    return {
        resume: out,
        violations: [{ code: 'key_achievements_emitted', detail: 'Strategist emitted a keyAchievements section — dropped; achievement material must be integrated into experience bullets and the summary metric.' }],
    };
}

/**
 * Deterministic, always-on pass: qualify scoped metrics where qualifiers are
 * allowed (experience highlights, key achievements), strip them where
 * qualifiers are banned (summary, skills, projects). Emits one violation per
 * claim that needed enforcement so the fix is observable.
 */
export function enforceScopedClaims(resume: StructuredResumeData): { resume: StructuredResumeData; violations: ResumeViolation[] } {
    let out = resume;
    const violations: ResumeViolation[] = [];
    for (const claim of SCOPED_CLAIMS) {
        const before = JSON.stringify(out);
        out = enforceClaimOnProse(enforceClaimOnSkills(enforceClaimOnHighlights(out, claim), claim), claim);
        if (JSON.stringify(out) !== before) {
            violations.push({ code: 'scoped_claim_unqualified', detail: `"${claim.label}" appeared without its scope qualifier — qualified in experience/achievements, removed from summary/skills/projects.` });
        }
    }
    return { resume: out, violations };
}

/** Normalize em-dashes in all prose fields of a StructuredResumeData. Defensive +
 *  shape-preserving: only transforms fields that are actually present (the guard is
 *  fail-open infra — never throw on a resume missing an optional array). */
export function stripEmDashes(resume: StructuredResumeData): StructuredResumeData {
    return {
        ...resume,
        ...(typeof resume.summary === 'string' ? { summary: normalizeProse(resume.summary) } : {}),
        ...(Array.isArray(resume.experience)
            ? { experience: resume.experience.map((e) => ({ ...e, highlights: Array.isArray(e.highlights) ? e.highlights.map((h) => normalizeProse(h)) : e.highlights })) }
            : {}),
        ...(Array.isArray(resume.projects)
            ? { projects: resume.projects.map((p) => ({ ...p, description: typeof p.description === 'string' ? normalizeProse(p.description) : p.description })) }
            : {}),
        ...(Array.isArray(resume.keyAchievements)
            ? { keyAchievements: resume.keyAchievements.map((k) => ({ ...k, achievement: typeof k.achievement === 'string' ? normalizeProse(k.achievement) : k.achievement })) }
            : {}),
    } as StructuredResumeData;
}

// =============================================================================
// HAIKU REWRITE + GUARD ORCHESTRATOR
// =============================================================================

const MODEL_ID = process.env['RESUME_REWRITE_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

const RewriteSchema = ResumeRewriteSchema;

const TOOL = buildEmitResumeTool('Return the corrected resume as structured JSON (plain text strings, NO markdown).');

const CTX: BasePipelineContext = {
    pipelineId: 'resume-guard',
    environment: process.env['DEPLOY_ENV'] ?? 'dev',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
};

/** Haiku rewrite that fixes ONLY the flagged issues. FAIL-OPEN: returns the input on error. */
export async function rewriteResume(
    resume: StructuredResumeData,
    violations: ResumeViolation[],
    ctx: ResumeGuardCtx,
): Promise<StructuredResumeData> {
    const system = [
        'You repair a tailored resume, fixing ONLY the listed issues by REORDERING and REWORDING for prominence. Call emit_resume with the full resume JSON.',
        `NEVER fabricate, NEVER change a number or date, NEVER rename a degree — the verified degree names are: ${ctx.verifiedEducation.join('; ')}.`,
        `Make the summary's FIRST sentence lead with this identity differentiator: "${ctx.leadIdentity}" — never an infrastructure-first opener; never name or concede any experience gap.`,
        'For headline_is_title: rewrite profile.title as a DESCRIPTIVE domain/capability headline with NO job-title noun (Engineer, Associate, Analyst, Manager, Developer, Specialist, Lead, Architect, Consultant…) — e.g. "Cloud & AI Operations · Python Automation & Incident Response". Never claim a role the candidate does not hold.',
        'For selected_work_misplaced: MOVE the "Selected work"/GitHub links highlight OUT of the support/customer/QA role and into the most senior builder/engineering role\'s highlights (e.g. Freelance / Cloud & DevOps). If no builder/engineering role exists, DROP that highlight. Never leave it under a support/customer-facing role.',
        `Put the "${ctx.archetypeSkillLead}" skill group FIRST (if present); within each group, JD-matched terms first.`,
        'Within each experience role, lead with the strongest number-led bullet.',
        'Preserve every fact, all education names verbatim, and the profile identity. Output plain-text strings, no markdown.',
    ].join('\n');

    const config: AgentConfig = {
        agentName: 'resume-rewrite',
        modelId: MODEL_ID,
        maxTokens: 8000,
        thinkingBudget: 0,
        systemPrompt: [{ text: system }],
        pipeline: 'job-strategist',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema as Record<string, unknown> },
    };

    const userMessage = `<issues>${violations.map((v) => v.code).join(', ')}</issues>\n<resume>${JSON.stringify(resume)}</resume>`;

    try {
        const result = await runAgent<StructuredResumeData>({
            config, userMessage, pipelineContext: CTX,
            parseResponse: (s) => {
                const parsed = RewriteSchema.safeParse(JSON.parse(s));
                if (!parsed.success) throw new Error(`resume-rewrite: ${parsed.error.message}`);
                return parsed.data as unknown as StructuredResumeData;
            },
        });
        return result.data;
    } catch (e) {
        log('WARN', 'resume rewrite failed — keeping original', { error: e instanceof Error ? e.message : String(e) });
        return resume;
    }
}

/** Validate → rewrite on violation → deterministic scoped-claim + section passes → return. Never throws. */
export async function guardResume(
    resume: StructuredResumeData,
    ctx: ResumeGuardCtx,
): Promise<{ resume: StructuredResumeData; violations: ResumeViolation[] }> {
    const violations = validateResume(resume, ctx);
    const rewritten = violations.length === 0 ? resume : await rewriteResume(resume, violations, ctx);
    const scoped = enforceScopedClaims(rewritten);
    violations.push(...scoped.violations);
    const sectioned = dropKeyAchievementsSection(scoped.resume);
    violations.push(...sectioned.violations);
    return { resume: stripEmDashes(sectioned.resume), violations };
}
