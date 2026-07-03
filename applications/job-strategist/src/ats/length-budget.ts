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
import { runAgent, log } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext, StructuredResumeData } from '@bedrock/shared';
import { ResumeRewriteSchema, buildEmitResumeTool } from '../agents/resume-tool-schema.js';
import type { ResumeViolation } from '../agents/resume-guard.js';

export const LENGTH_BUDGET = {
    /** ~2 rendered A4 pages at the ATS template's density. */
    totalWords:               880,
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
    const overBudget: string[] = [];
    if (summary > LENGTH_BUDGET.summaryWords) overBudget.push('summary');
    if (experience > LENGTH_BUDGET.experienceWords) overBudget.push('experience');
    if (skills > LENGTH_BUDGET.skillsWords) overBudget.push('skills');
    if (projects > LENGTH_BUDGET.projectsWords) overBudget.push('projects');
    if (total > LENGTH_BUDGET.totalWords) overBudget.push('total');
    return { summary, experience, skills, projects, total, overBudget };
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
            .map((s) => (words(s) > LENGTH_BUDGET.perSkillItemWords ? s.replace(/\s*\([^)]*\)/g, '').trim() : s))
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
        'PRIORITISE BY THE JD: content that answers a required skill, a responsibility, or the company problem below stays; content that answers none of them is cut FIRST. Do not saturate — one strong proof per JD requirement beats three restatements.',
        `Required skills: ${jd.requiredSkills.join(', ') || 'n/a'}.`,
        `Company problem: ${jd.companyProblem || 'n/a'}.`,
        `Responsibilities: ${jd.responsibilities.slice(0, 6).join(' | ') || 'n/a'}.`,
        'HARD TARGETS (words):',
        `- summary <= ${LENGTH_BUDGET.summaryWords} (currently ${measure.summary}); keep the closing metric sentence.`,
        `- experience total <= ${LENGTH_BUDGET.experienceWords} (currently ${measure.experience}); max ${LENGTH_BUDGET.maxBulletsPerRole} bullets per role; EVERY bullet <= ${LENGTH_BUDGET.perBulletWords} words, one sentence, verb-first, dry — no "as measured by X, by Y" chains, keep one impact clause.`,
        `- skills total <= ${LENGTH_BUDGET.skillsWords} (currently ${measure.skills}); a skill is a NAME (<= ${LENGTH_BUDGET.perSkillItemWords} words), never a sentence; max ${LENGTH_BUDGET.maxSkillItemsPerCategory} items per category; keep JD-required skills first, cut the rest.`,
        `- projects total <= ${LENGTH_BUDGET.projectsWords} (currently ${measure.projects}); each description <= ${LENGTH_BUDGET.perProjectWords} words — what it is, the JD-relevant proof, one metric. No stack dumps.`,
        `- grand total <= ${LENGTH_BUDGET.totalWords} (currently ${measure.total}).`,
        'Style: industry-standard, terse, no adjectives without evidence, no repeated technology lists across sections.',
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

/**
 * Full enforcement pass: measure → condense (once) → hard trim → measure.
 * Never throws; `onViolation` reports each enforcement step for metrics.
 */
export async function applyLengthBudget(
    resume: StructuredResumeData,
    jd: JdPriorityContext,
    onViolation?: (v: ResumeViolation) => void,
): Promise<StructuredResumeData> {
    const before = measureResume(resume);
    if (before.overBudget.length === 0) return resume;
    onViolation?.({ code: 'length_over_budget', detail: `Sections over budget: ${before.overBudget.join(', ')} (total ${before.total}/${LENGTH_BUDGET.totalWords} words).` });

    const condensed = await condenseResume(resume, before, jd);
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
