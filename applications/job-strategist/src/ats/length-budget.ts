/** @format */
/**
 * Resume length budget — measurement + enforcement.
 *
 * The persona prompt has carried per-section word budgets since day one, and
 * a live run still shipped a 1,723-word / 4-page resume (projects 3x over,
 * skills 2.3x over, a 91-word bullet). Prompt rules are the first attempt;
 * this module is the enforcement layer:
 *
 *   measure → (over budget?) one bounded Haiku condense rewrite, JD-aware →
 *   re-measure → deterministic hard trims as the backstop.
 *
 * Hard trims only ever drop WHOLE units (skill items, trailing project
 * sentences, bullets beyond the per-role cap, middle summary sentences) —
 * never mid-sentence chops. Bullets are ordered by JD relevance upstream, so
 * dropping from the end removes the least relevant content first.
 */
import { CLAIM_STRENGTH_RULE } from '../lib/claim-strength.js';
import { runAgent, log } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext, StructuredResumeData } from '@bedrock/shared';
import { ResumeRewriteSchema, buildEmitResumeTool } from '../agents/resume-tool-schema.js';
import type { ResumeViolation } from '../agents/resume-guard.js';
import { preserveExperienceRoster } from '../agents/resume-guard.js';

export const LENGTH_BUDGET = {
    /** ~2 rendered A4 pages at the ATS template's density. */
    totalWords:               880,
    /** Below this the second page is visibly half-empty — expand with
     *  grounded, JD-relevant content (never padding). */
    minTotalWords:            700,
    minBulletsPerRole:        2,
    summaryWords:             100,
    experienceWords:          370,
    skillsWords:              150,
    projectsWords:            160,
    perBulletWords:           32,
    perProjectWords:          80,
    perSkillItemWords:        6,
    maxSkillItemsPerCategory: 8,
    maxBulletsPerRole:        5,
} as const;

const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

export interface ResumeMeasure {
    readonly summary: number;
    readonly experience: number;
    readonly skills: number;
    readonly projects: number;
    readonly total: number;
    /** Section names over their budget (empty = within budget). */
    readonly overBudget: string[];
    /** True when the resume leaves the second page visibly half-empty. */
    readonly underFilled: boolean;
    /** Roles carrying fewer than the minimum bullets (single-bullet roles read as filler). */
    readonly thinRoles: string[];
}

export function measureResume(resume: StructuredResumeData): ResumeMeasure {
    const summary = words(resume.summary ?? '');
    const experience = (resume.experience ?? [])
        .flatMap((e) => e.highlights ?? [])
        .reduce((n, h) => n + words(h), 0);
    const skills = (resume.skills ?? [])
        .flatMap((g) => g.skills ?? [])
        .reduce((n, s) => n + words(s), 0);
    const projects = (resume.projects ?? [])
        .reduce((n, p) => n + words(p.description ?? ''), 0);
    const total = summary + experience + skills + projects;
    return {
        summary, experience, skills, projects, total,
        overBudget: overBudgetSections({ summary, experience, skills, projects, total }),
        underFilled: total < LENGTH_BUDGET.minTotalWords,
        thinRoles: thinRolesOf(resume),
    };
}

function overBudgetSections(m: { summary: number; experience: number; skills: number; projects: number; total: number }): string[] {
    const over: string[] = [];
    if (m.summary > LENGTH_BUDGET.summaryWords) over.push('summary');
    if (m.experience > LENGTH_BUDGET.experienceWords) over.push('experience');
    if (m.skills > LENGTH_BUDGET.skillsWords) over.push('skills');
    if (m.projects > LENGTH_BUDGET.projectsWords) over.push('projects');
    if (m.total > LENGTH_BUDGET.totalWords) over.push('total');
    return over;
}

/** Roles with SOME bullets but fewer than the minimum (single-bullet roles read as filler). */
function thinRolesOf(resume: StructuredResumeData): string[] {
    return (resume.experience ?? [])
        .filter((e) => (e.highlights ?? []).length > 0 && (e.highlights ?? []).length < LENGTH_BUDGET.minBulletsPerRole)
        .map((e) => e.title);
}

// =============================================================================
// DETERMINISTIC HARD TRIMS (whole units only)
// =============================================================================

/**
 * Keep the first sentences of a prose block up to `capWords`. A single
 * sentence longer than the cap is degenerate prose (run-on stack dump) —
 * truncate it at the cap's word boundary rather than let it defeat the trim.
 */
function trimSentences(text: string, capWords: number): string {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const kept: string[] = [];
    let count = 0;
    for (const s of sentences) {
        const w = words(s);
        if (kept.length > 0 && count + w > capWords) break;
        kept.push(s);
        count += w;
    }
    let out = kept.join(' ').trim();
    if (words(out) > capWords) {
        out = out.split(/\s+/).slice(0, capWords).join(' ').replace(/[,;:.]?$/, '.');
    }
    return out;
}

function hardTrimSkills(resume: StructuredResumeData): StructuredResumeData {
    const skills = (resume.skills ?? []).map((g) => ({
        ...g,
        skills: (g.skills ?? [])
            // A "skill" longer than the cap is a sentence, not a name — drop the
            // parenthetical first; if it is still prose, drop the item.
            .map((s) => (words(s) > LENGTH_BUDGET.perSkillItemWords ? s.replace(/ ?\([^)]*\)/g, '').trim() : s))
            .filter((s) => s.length > 0 && words(s) <= LENGTH_BUDGET.perSkillItemWords * 2)
            .slice(0, LENGTH_BUDGET.maxSkillItemsPerCategory),
    }));
    return { ...resume, skills };
}

function hardTrimProjects(resume: StructuredResumeData): StructuredResumeData {
    const projects = (resume.projects ?? []).map((p) => ({
        ...p,
        description: typeof p.description === 'string'
            ? trimSentences(p.description, LENGTH_BUDGET.perProjectWords)
            : p.description,
    }));
    return { ...resume, projects };
}

function hardTrimExperience(resume: StructuredResumeData): StructuredResumeData {
    const experience = (resume.experience ?? []).map((e) => ({
        ...e,
        highlights: (e.highlights ?? []).slice(0, LENGTH_BUDGET.maxBulletsPerRole),
    }));
    return { ...resume, experience };
}

function hardTrimSummary(resume: StructuredResumeData): StructuredResumeData {
    if (words(resume.summary ?? '') <= LENGTH_BUDGET.summaryWords) return resume;
    // The closing metric sentence is protected by the persona rules — trim
    // middle sentences, keeping the first (positioning) and last (metric).
    const sentences = (resume.summary ?? '').split(/(?<=[.!?])\s+/);
    if (sentences.length <= 2) return resume;
    let kept = [...sentences];
    while (kept.length > 2 && words(kept.join(' ')) > LENGTH_BUDGET.summaryWords) {
        kept = [kept[0], ...kept.slice(2)];
    }
    return { ...resume, summary: kept.join(' ') };
}

/** Whole-unit trims, applied only to sections still over budget. */
export function hardTrim(resume: StructuredResumeData): StructuredResumeData {
    const m = measureResume(resume);
    let out = resume;
    if (m.overBudget.includes('skills')) out = hardTrimSkills(out);
    if (m.overBudget.includes('projects')) out = hardTrimProjects(out);
    if (m.overBudget.includes('experience') || m.overBudget.includes('total')) out = hardTrimExperience(out);
    if (m.overBudget.includes('summary')) out = hardTrimSummary(out);
    return out;
}

// =============================================================================
// HAIKU CONDENSE (one bounded, JD-aware rewrite)
// =============================================================================

const MODEL_ID = process.env['RESUME_REWRITE_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
const TOOL = buildEmitResumeTool('Return the condensed resume as structured JSON (plain-text strings, NO markdown).');
const CTX: BasePipelineContext = { pipelineId: 'length-budget', environment: process.env['DEPLOY_ENV'] ?? 'dev', cumulativeTokens: { input: 0, output: 0, thinking: 0 }, cumulativeCostUsd: 0 };

export interface JdPriorityContext {
    readonly requiredSkills: readonly string[];
    readonly companyProblem: string;
    readonly responsibilities: readonly string[];
}

/** FAIL-OPEN: returns the input on any error. */
export async function condenseResume(
    resume: StructuredResumeData,
    measure: ResumeMeasure,
    jd: JdPriorityContext,
): Promise<StructuredResumeData> {
    const system = [
        'You CONDENSE a tailored resume that is over its length budget. Call emit_resume with the full resume JSON.',
        'NEVER fabricate; NEVER add content; NEVER change a number, date, name, or degree. Only cut and tighten.',
        'NEVER remove an entire experience role — trim bullets within roles, but every role in the input appears in the output.',
        'PRIORITISE BY THE JD: content that answers a required skill, a responsibility, or the company problem below stays; content that answers none of them is cut FIRST. Do not saturate — one strong proof per JD requirement beats three restatements.',
        `Required skills: ${jd.requiredSkills.join(', ') || 'n/a'}.`,
        `Company problem: ${jd.companyProblem || 'n/a'}.`,
        `Responsibilities: ${jd.responsibilities.slice(0, 6).join(' | ') || 'n/a'}.`,
        'HARD TARGETS (words):',
        `- summary <= ${LENGTH_BUDGET.summaryWords} (currently ${measure.summary}); keep the closing metric sentence.`,
        `- experience total <= ${LENGTH_BUDGET.experienceWords} (currently ${measure.experience}); max ${LENGTH_BUDGET.maxBulletsPerRole} bullets per role; EVERY bullet <= ${LENGTH_BUDGET.perBulletWords} words, one sentence, verb-first, dry — no "as measured by X, by Y" chains.`,
        '- IMPACT CLAUSES ARE PROTECTED: every bullet keeps exactly ONE impact clause (its measured number or qualitative benefit, e.g. "eliminating static credentials"). When cutting, remove scope enumerations, adjectives, and tool lists FIRST — never the benefit.',
        `- skills total <= ${LENGTH_BUDGET.skillsWords} (currently ${measure.skills}); a skill is a NAME (<= ${LENGTH_BUDGET.perSkillItemWords} words), never a sentence; max ${LENGTH_BUDGET.maxSkillItemsPerCategory} items per category; keep JD-required skills first, cut the rest.`,
        `- projects total <= ${LENGTH_BUDGET.projectsWords} (currently ${measure.projects}); each description <= ${LENGTH_BUDGET.perProjectWords} words — what it is, the JD-relevant proof, one metric. No stack dumps.`,
        `- grand total <= ${LENGTH_BUDGET.totalWords} (currently ${measure.total}).`,
        'Style: industry-standard, terse, no adjectives without evidence, no repeated technology lists across sections.',
        CLAIM_STRENGTH_RULE,
    ].join('\n');

    const config: AgentConfig = {
        agentName: 'resume-condense', modelId: MODEL_ID, maxTokens: 8000, thinkingBudget: 0,
        systemPrompt: [{ text: system }], pipeline: 'job-strategist',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema as Record<string, unknown> },
    };
    try {
        const result = await runAgent<StructuredResumeData>({
            config, userMessage: `<resume>${JSON.stringify(resume)}</resume>`, pipelineContext: CTX,
            parseResponse: (s) => {
                const parsed = ResumeRewriteSchema.safeParse(JSON.parse(s));
                if (!parsed.success) throw new Error(`resume-condense: ${parsed.error.message}`);
                return parsed.data as unknown as StructuredResumeData;
            },
        });
        return result.data;
    } catch (e) {
        log('WARN', 'resume condense failed — falling through to hard trim', { error: e instanceof Error ? e.message : String(e) });
        return resume;
    }
}

/** Optional grounding for the expand direction (never expand without it). */
export interface LengthBudgetOpts {
    /** Verbatim career facts + project evidence + verified citations — the ONLY
     *  material the expand pass may draw on. */
    readonly groundingFacts?: string;
}

/**
 * EXPAND (fail-open): the mirror of condense. Fires when the resume leaves
 * the second page half-empty (the A/B run shipped 425/880 words with a
 * single-bullet role) — grow with GROUNDED, JD-relevant content only:
 * a second bullet for thin roles, up to 5 bullets for the primary role,
 * fuller pitch-led project beats. Never padding, never invented numbers —
 * the caller strips ungrounded numbers afterwards.
 */
export async function expandResume(
    resume: StructuredResumeData,
    measure: ResumeMeasure,
    jd: JdPriorityContext,
    groundingFacts: string,
): Promise<StructuredResumeData> {
    const system = [
        'You EXPAND an under-filled tailored resume. Call emit_resume with the full resume JSON.',
        'GROUNDING IS ABSOLUTE: every added claim must come from the grounding facts provided — NEVER invent a fact, number, technology, or outcome. Do not touch education or certifications. Keep every existing fact.',
        'NEVER remove an entire experience role — every role in the input appears in the output.',
        `PRIORITISE BY THE JD — add only content answering a required skill, responsibility, or the company problem: ${jd.requiredSkills.join(', ') || 'n/a'} | ${jd.companyProblem || 'n/a'}.`,
        'TARGETS:',
        `- grand total ${LENGTH_BUDGET.minTotalWords}-${LENGTH_BUDGET.totalWords} words (currently ${measure.total}) — the resume must FILL two pages with relevant evidence, never overflow them.`,
        measure.thinRoles.length > 0 ? `- EVERY role needs >= ${LENGTH_BUDGET.minBulletsPerRole} bullets when the grounding facts support them (thin roles: ${measure.thinRoles.join('; ')}). A single-bullet role reads as filler.` : '- keep role bullet counts balanced.',
        `- the primary (most JD-relevant) role may grow to ${LENGTH_BUDGET.maxBulletsPerRole} bullets; every bullet <= ${LENGTH_BUDGET.perBulletWords} words, one impact clause.`,
        `- projects may grow toward ${LENGTH_BUDGET.perProjectWords} words each: pitch-led, one differentiator, one fresh metric — never stack dumps.`,
        'Style stays dry and verb-first. No repetition of existing bullets in new ones.',
        CLAIM_STRENGTH_RULE,
    ].join('\n');
    const config: AgentConfig = {
        agentName: 'resume-expand', modelId: MODEL_ID, maxTokens: 8000, thinkingBudget: 0,
        systemPrompt: [{ text: system }], pipeline: 'job-strategist',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema as Record<string, unknown> },
    };
    try {
        const result = await runAgent<StructuredResumeData>({
            config, userMessage: `<grounding_facts>${groundingFacts}</grounding_facts>\n<resume>${JSON.stringify(resume)}</resume>`, pipelineContext: CTX,
            parseResponse: (raw) => {
                const parsed = ResumeRewriteSchema.safeParse(JSON.parse(raw));
                if (!parsed.success) throw new Error(`resume-expand: ${parsed.error.message}`);
                return parsed.data as unknown as StructuredResumeData;
            },
        });
        return result.data;
    } catch (e) {
        log('WARN', 'resume expand failed — keeping original', { error: e instanceof Error ? e.message : String(e) });
        return resume;
    }
}

/**
 * Full enforcement pass, both directions: over budget → condense (once) +
 * hard trim; under-filled (and grounding available) → expand (once) + trim
 * any overshoot. Never throws; `onViolation` reports each step.
 */
async function shrinkToBudget(
    resume: StructuredResumeData,
    before: ResumeMeasure,
    jd: JdPriorityContext,
    onViolation?: (v: ResumeViolation) => void,
): Promise<StructuredResumeData> {
    onViolation?.({ code: 'length_over_budget', detail: `Sections over budget: ${before.overBudget.join(', ')} (total ${before.total}/${LENGTH_BUDGET.totalWords} words).` });
    const condensed = preserveExperienceRoster(resume, await condenseResume(resume, before, jd), onViolation);
    let out = condensed;
    let m = measureResume(out);
    if (condensed !== resume && m.total < before.total) {
        onViolation?.({ code: 'length_condensed', detail: `Condense rewrite: ${before.total} -> ${m.total} words.` });
    }
    if (m.overBudget.length > 0) {
        out = hardTrim(out);
        m = measureResume(out);
        onViolation?.({ code: 'length_hard_trimmed', detail: `Hard trim applied; final ${m.total} words (over: ${m.overBudget.join(', ') || 'none'}).` });
    }
    return out;
}

async function growToFill(
    resume: StructuredResumeData,
    before: ResumeMeasure,
    jd: JdPriorityContext,
    groundingFacts: string,
    onViolation?: (v: ResumeViolation) => void,
): Promise<StructuredResumeData> {
    const thin = before.thinRoles.length > 0 ? `; thin roles: ${before.thinRoles.join('; ')}` : '';
    onViolation?.({ code: 'length_under_filled', detail: `Resume under-fills two pages (total ${before.total}/${LENGTH_BUDGET.minTotalWords} min${thin}).` });
    const expanded = preserveExperienceRoster(resume, await expandResume(resume, before, jd, groundingFacts), onViolation);
    if (expanded === resume) return resume;
    let out = expanded;
    if (measureResume(out).overBudget.length > 0) out = hardTrim(out);
    onViolation?.({ code: 'length_expanded', detail: `Expand pass: ${before.total} -> ${measureResume(out).total} words.` });
    return out;
}

export async function applyLengthBudget(
    resume: StructuredResumeData,
    jd: JdPriorityContext,
    onViolation?: (v: ResumeViolation) => void,
    opts: LengthBudgetOpts = {},
): Promise<StructuredResumeData> {
    const before = measureResume(resume);
    if (before.overBudget.length > 0) return shrinkToBudget(resume, before, jd, onViolation);
    if ((before.underFilled || before.thinRoles.length > 0) && opts.groundingFacts) {
        return growToFill(resume, before, jd, opts.groundingFacts, onViolation);
    }
    return resume;
}
