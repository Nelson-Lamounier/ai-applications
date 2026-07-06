/** @format */
import { z } from 'zod';
import { runAgent, log } from '@bedrock/shared';
import type { AgentConfig, BasePipelineContext } from '@bedrock/shared';

export interface YearInterval { startYear: number; endYear: number; }

/** Parse a free-form period to a year interval. `Present`/`Current` → nowYear. */
export function parsePeriod(period: string, nowYear: number): YearInterval | null {
    const parts = period.split(/[-–—]/);
    if (parts.length < 2) return null;
    const startYear = firstYear(parts[0]);
    const endRaw = parts.slice(1).join('-');
    const endYear = /present|current/i.test(endRaw) ? nowYear : firstYear(endRaw);
    if (startYear === null || endYear === null || endYear < startYear) return null;
    return { startYear, endYear };
}

function firstYear(s: string): number | null {
    const m = /(19|20)\d{2}/.exec(s);
    return m ? Number.parseInt(m[0], 10) : null;
}

/** Merge overlapping intervals, sum the merged lengths, round to 1 decimal. */
export function unionYears(intervals: YearInterval[]): number {
    if (intervals.length === 0) return 0;
    const sorted = [...intervals].sort((a, b) => a.startYear - b.startYear);
    let total = 0;
    let curStart = sorted[0].startYear;
    let curEnd = sorted[0].endYear;
    for (let i = 1; i < sorted.length; i++) {
        const iv = sorted[i];
        if (iv.startYear <= curEnd) {
            if (iv.endYear > curEnd) curEnd = iv.endYear;
        } else {
            total += curEnd - curStart;
            curStart = iv.startYear;
            curEnd = iv.endYear;
        }
    }
    total += curEnd - curStart;
    return Math.round(total * 10) / 10;
}

/** Parse the JD's expected years to the floor the candidate must clear. */
export function parseRequiredYears(yearsExpected: string): number | null {
    const m = /(\d{1,2})/.exec(yearsExpected);
    return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Deterministic anti-undersell reconciliation. The Haiku framing line may state a
 * SMALLER year count than the deterministic union (`relevantYears`). If the first
 * "<n> years" number in the line is LESS than the true union, replace it with the
 * union. If the line has no number, prefix the true count. Guarantee: the framing
 * never states fewer years than the deterministic union.
 */
export function reconcileFramingYears(framingLine: string, relevantYears: number): string {
    const line = framingLine.trim();
    if (!line) return line;
    const m = /\b(\d{1,2})\s*(?:\+)?\s*years?\b/.exec(line);
    if (m) {
        return reconcileMatchedYears(line, m, relevantYears);
    }
    return `${relevantYears} years — ${line}`;
}

function reconcileMatchedYears(line: string, m: RegExpExecArray, relevantYears: number): string {
    const stated = Number.parseInt(m[1], 10);
    if (stated >= relevantYears) return line;
    // Replace only the matched number, preserving surrounding text (and any "+"/"years").
    const replaced = m[0].replace(/\d{1,2}/, String(relevantYears));
    return line.slice(0, m.index) + replaced + line.slice(m.index + m[0].length);
}

// =============================================================================
// YEARS-RELEVANCE AGENT + buildYearsGap ORCHESTRATOR
// =============================================================================

const MODEL_ID = process.env['YEARS_RELEVANCE_MODEL'] ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

export interface YearsGapRole {
    title: string; company: string; period: string;
    family: string | null; roleClass: string | null;
}

export interface YearsGap {
    relevantYears: number;
    requiredYears: number | null;
    gapYears: number;
    disqualifying: boolean;
    relevantRoleTitles: string[];
    framingLine: string;
}

const RelevanceSchema = z.object({
    relevantTitles: z.array(z.string()).default([]),
    framingLine:    z.string().default(''),
});

const TOOL = {
    name: 'emit_years_relevance',
    description: 'Select the roles that count toward the JD experience requirement and write a true framing line.',
    input_schema: {
        type: 'object',
        properties: {
            relevantTitles: { type: 'array', items: { type: 'string' }, description: 'Exact titles of roles that legitimately count toward the JD experience requirement.' },
            framingLine:    { type: 'string', description: 'One true line aggregating the relevant breadth + the relevant-years number. Never claim the required number; never apologise.' },
        },
        required: ['relevantTitles', 'framingLine'],
        additionalProperties: false,
    },
} as const;

const CTX: BasePipelineContext = { pipelineId: 'years-gap', environment: process.env['DEPLOY_ENV'] ?? 'dev', cumulativeTokens: { input: 0, output: 0, thinking: 0 }, cumulativeCostUsd: 0 };

async function selectRelevant(roles: YearsGapRole[], yearsExpected: string): Promise<{ relevantTitles: string[]; framingLine: string }> {
    const system = [
        'You decide which of a candidate\'s past roles legitimately count toward a job\'s experience requirement, and write ONE true framing line.',
        'Call emit_years_relevance. Rules:',
        '- Include a role when its function relates to the requirement (use its family/role-class, not just an exact title match).',
        '- framingLine: a true re-description aggregating the relevant breadth + the relevant-years number. Use the union of ALL relevant role spans (overlapping roles count once across the combined calendar range), never a single role\'s tenure. Never claim the required number; never invent; never apologise.',
        '- framingLine VOICE: a subjectless noun phrase, e.g. "approximately 5 years across technical support, cloud infrastructure and quality assurance". NEVER "this candidate…", "the candidate…", or any sentence with a subject — the line is embedded into both first-person and impersonal documents and must read naturally in each.',
    ].join('\n');
    const config: AgentConfig = {
        agentName: 'years-relevance', modelId: MODEL_ID, maxTokens: 512, thinkingBudget: 0,
        systemPrompt: [{ text: system }], pipeline: 'job-strategist',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema as Record<string, unknown> },
    };
    const rolesXml = roles.map((r) => `<role><title>${r.title}</title><company>${r.company}</company><period>${r.period}</period><family>${r.family ?? ''}</family><class>${r.roleClass ?? ''}</class></role>`).join('');
    const userMessage = `<required_years>${yearsExpected}</required_years><roles>${rolesXml}</roles>`;
    const result = await runAgent<{ relevantTitles: string[]; framingLine: string }>({
        config, userMessage, pipelineContext: CTX,
        parseResponse: (s) => {
            const v = RelevanceSchema.safeParse(JSON.parse(s));
            if (!v.success) throw new Error(`years-relevance: schema validation failed: ${v.error.message}`);
            return v.data;
        },
    });
    return result.data;
}

/**
 * Build the years-gap. FAIL-OPEN: null when no role parses; on agent failure,
 * falls back to ALL parseable roles + a plain framing line so a number still shows.
 */
export async function buildYearsGap(
    roles: YearsGapRole[],
    yearsExpected: string,
    yearsBarDisqualifying: boolean,
    nowYear: number,
): Promise<YearsGap | null> {
    const parsed = roles
        .map((r) => ({ role: r, iv: parsePeriod(r.period, nowYear) }))
        .filter((p): p is { role: YearsGapRole; iv: YearInterval } => p.iv !== null);
    if (parsed.length === 0) return null;

    let relevantTitles: string[];
    let framingLine: string;
    try {
        const sel = await selectRelevant(roles, yearsExpected);
        if (sel.relevantTitles.length === 0) throw new Error('empty selection');
        relevantTitles = sel.relevantTitles;
        framingLine = sel.framingLine;
    } catch (e) {
        log('WARN', 'years relevance agent failed — falling back to all roles', { error: e instanceof Error ? e.message : String(e) });
        relevantTitles = parsed.map((p) => p.role.title);
        framingLine = '';
    }

    const relevantIvs = parsed.filter((p) => relevantTitles.includes(p.role.title)).map((p) => p.iv);
    const relevantYears = unionYears(relevantIvs.length > 0 ? relevantIvs : parsed.map((p) => p.iv));
    if (!framingLine) {
        framingLine = `${relevantYears} years of relevant experience`;
    } else {
        framingLine = reconcileFramingYears(framingLine, relevantYears);
    }

    const requiredYears = parseRequiredYears(yearsExpected);
    const gapYears = requiredYears === null ? 0 : Math.max(0, Math.round((requiredYears - relevantYears) * 10) / 10);
    const disqualifying = gapYears > 0 && yearsBarDisqualifying;

    return { relevantYears, requiredYears, gapYears, disqualifying, relevantRoleTitles: relevantTitles, framingLine };
}
