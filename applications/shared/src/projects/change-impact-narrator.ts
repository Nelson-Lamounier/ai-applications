/**
 * @format
 * change-impact-narrator — grounded LLM narration of a file's change impact.
 *
 * Inc 3b: the Bedrock agent over a {@link ChangeImpactReport}. It narrates the
 * computed/measured facts in plain English but is structurally forbidden from
 * inventing a number — the model output is checked by {@link isGrounded} and,
 * if it cites any figure not in the report (beyond display-rounding tolerance),
 * is DISCARDED in favour of a deterministic narration built only from the facts.
 * So the served narration is always grounded, whatever the model does.
 *
 * The model call is injected (`opts.invoke`) so the agent is fully unit-testable
 * without live Bedrock; the default invoker uses runAgent with a forced tool.
 *
 * Per the repo LLM-workflow rules: phase-specific prompt, one tight forced-tool
 * schema, Sonnet by default (nuanced narration), and a per-phase anti-fabrication
 * eval (change-impact-narrator.eval.test.ts).
 */

import { z } from 'zod';

import { runAgent } from '../agent-runner.js';
import type { AgentConfig } from '../types.js';
import type { BasePipelineContext } from '../base-agent.js';
import type { ChangeImpactReport } from './change-metrics.js';
import { isGrounded } from './change-impact-grounding.js';

/** Sonnet by default — nuanced structured narration (CLAUDE.md §4). */
const MODEL_ID = process.env['CHANGE_IMPACT_MODEL'] ?? 'eu.anthropic.claude-sonnet-4-6';

export interface ChangeImpactNarration {
    readonly summary: string;
    readonly performanceLine: string;
    /** Always true for the served output — fabricated model output is replaced. */
    readonly grounded: boolean;
    /** 'model' when the LLM narration passed the gate; 'deterministic' on fallback. */
    readonly source: 'model' | 'deterministic';
}

/** The raw narration shape the model (or an injected stub) returns. */
export interface RawNarration {
    readonly summary: string;
    readonly performanceLine: string;
}

export type NarrateInvoke = (report: ChangeImpactReport) => Promise<RawNarration>;

/**
 * Narrate a change-impact report. Tries the model; serves its output only if it
 * cites no fabricated number, else falls back to a deterministic, always-grounded
 * narration. Never throws — a model failure degrades to the deterministic facts.
 */
export async function narrateChangeImpact(
    report: ChangeImpactReport,
    opts: { invoke?: NarrateInvoke } = {},
): Promise<ChangeImpactNarration> {
    const invoke = opts.invoke ?? defaultInvoke;

    let model: RawNarration | null = null;
    try {
        model = await invoke(report);
    } catch {
        model = null;
    }

    if (model && isGrounded(`${model.summary}\n${model.performanceLine}`, report)) {
        return { summary: model.summary, performanceLine: model.performanceLine, grounded: true, source: 'model' };
    }

    const det = buildDeterministicNarration(report);
    return { ...det, grounded: true, source: 'deterministic' };
}

/**
 * Deterministic narration built ONLY from the report's facts — the always-grounded
 * fallback and the floor of honesty. Cites no number absent from the report and
 * states a percentage only when one was measured.
 */
export function buildDeterministicNarration(report: ChangeImpactReport): RawNarration {
    const s = report.structural;
    const netSign = s.netLoc >= 0 ? '+' : '';
    const cplx =
        s.complexityDelta === 0 ? 'no change in branching'
        : s.complexityDelta < 0 ? `${Math.abs(s.complexityDelta)} fewer decision points`
        : `${s.complexityDelta} more decision points`;

    const summary =
        `${report.filePath} changed across ${s.changeCount} commit(s): ` +
        `${s.churn} lines churned, net ${netSign}${s.netLoc}; ${cplx}.`;

    const performanceLine = report.hasMeasuredPerf
        ? report.performance
              .map((p) => {
                  const pct = p.percentChange !== null ? ` (${p.percentChange}%)` : '';
                  return `${p.metric}: ${p.before}${p.unit} → ${p.after}${p.unit}${pct}`;
              })
              .join('; ')
        : 'No measured performance data for these commits — no percentage claimed.';

    return { summary, performanceLine };
}

// =============================================================================
// Default model invoker (production) — forced-tool JSON via runAgent
// =============================================================================

const TOOL = {
    name: 'emit_change_impact',
    description: 'Narrate the change impact from the provided facts. Cite only those numbers; never invent or estimate.',
    input_schema: {
        type: 'object',
        properties: {
            summary: {
                type: 'string',
                description: 'One or two plain sentences: what changed and its effect, citing ONLY numbers present in the facts. No hype, no invented figures.',
            },
            performanceLine: {
                type: 'string',
                description: 'Measured performance change, using ONLY the measured before/after/percent provided. If no measured perf is given, say no measurement exists and claim no percentage.',
            },
        },
        required: ['summary', 'performanceLine'],
        additionalProperties: false,
    },
} as const;

const OutputSchema = z.object({
    summary:         z.string().default(''),
    performanceLine: z.string().default(''),
});

const SYSTEM = [
    'You write a short, honest change-impact note from STRUCTURED FACTS about one file\'s git history.',
    'Call emit_change_impact. Rules:',
    '- Cite ONLY numbers that appear in the provided facts. Never invent, round away, or estimate a number.',
    '- State a performance percentage ONLY if a measured before/after is provided. If none is given, say there is no measurement and claim NO percentage.',
    '- Be concise and factual. No marketing language, no superlatives, no apologies.',
].join('\n');

function buildChangeImpactMessage(report: ChangeImpactReport): string {
    // Hand the model the exact facts as JSON — the only numbers it may cite.
    return `Facts (cite only these numbers):\n${JSON.stringify(report, null, 2)}`;
}

function narrationContext(): BasePipelineContext {
    return {
        pipelineId:        'change-impact',
        environment:       process.env['DEPLOY_ENV'] ?? 'development',
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
    };
}

async function defaultInvoke(report: ChangeImpactReport): Promise<RawNarration> {
    const config: AgentConfig = {
        agentName:      'change-impact',
        modelId:        MODEL_ID,
        maxTokens:      512,
        thinkingBudget: 0, // forced tool_use requires no extended thinking
        systemPrompt:   [{ text: SYSTEM }],
        pipeline:       'change-impact',
        tool: { name: TOOL.name, description: TOOL.description, inputSchema: TOOL.input_schema as Record<string, unknown> },
    };

    const result = await runAgent<RawNarration>({
        config,
        userMessage:     buildChangeImpactMessage(report),
        pipelineContext: narrationContext(),
        parseResponse:   (s) => {
            const v = OutputSchema.safeParse(JSON.parse(s));
            if (!v.success) throw new Error(`change-impact: schema validation failed: ${v.error.message}`);
            return v.data;
        },
    });
    return result.data;
}
