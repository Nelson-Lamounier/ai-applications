/**
 * @format
 * Project System-Tour Agent — Bedrock tool-use, Sonnet 4.6.
 *
 * One invocation per project. Unlike the case-study agent, the ONLY input
 * is an already-generated, already-grounded `CaseStudy`. The model
 * re-projects that case study into the narrative order a candidate would
 * present in an architecture-review round: area, context, key decisions,
 * tradeoffs, the system map, outcomes, and the one genuinely-new field —
 * `whatIdChange`.
 *
 * Honesty discipline (asserted in the tests):
 *   1. Ground EVERY element strictly in the provided case study; it is the
 *      sole evidence source — never introduce un-evidenced claims.
 *   2. `systemMap` MUST be the case study's `architecture` reused verbatim
 *      (no new diagram is invented).
 *   3. `whatIdChange` may ONLY cite evidenced limitations (the case study's
 *      `challenges` / `depthMarkers`); return `[]` if none — never invent
 *      regrets.
 *
 * Mirrors `case-study-agent.ts`: forced tool_use, `runAgent<T>`,
 * `parseJsonResponse` + Zod `safeParse` fail-fast validation. Exposes a
 * `CaseStudyAgent`-style interface so tests can inject a mock without
 * spinning up Bedrock.
 */
import { runAgent, parseJsonResponse } from '../../agent-runner.js';
import type { BasePipelineContext } from '../../base-agent.js';
import type { AgentConfig, AgentResult } from '../../types.js';

import {
    SystemTourSchema,
    type SystemTour,
} from './system-tour-types.js';
import type { CaseStudy } from '../case-study/case-study-types.js';
import { PROJECT_COMPONENT_KINDS } from '../types.js';

// ─── Configuration ──────────────────────────────────────────────────────────

const SYSTEM_TOUR_MODEL =
    process.env.SYSTEM_TOUR_MODEL ??
    'eu.anthropic.claude-sonnet-4-6';

const EFFECTIVE_MODEL_ID =
    process.env.INFERENCE_PROFILE_ARN ?? SYSTEM_TOUR_MODEL;

// The system tour is a re-projection of an existing case study — strictly
// smaller than the full case-study payload. 16k gives the structured JSON
// ample room while staying well under the output max and the context budget.
const SYSTEM_TOUR_MAX_TOKENS = 16_384;

/** Forced tool_use is incompatible with extended thinking. */
const SYSTEM_TOUR_THINKING_BUDGET = 0;

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEXT = `You are a staff engineer narrating a "system tour" of a single project
for an architecture-review interview round. You re-project an existing,
already-grounded case study into the order a candidate would walk an
interviewer through the system: what it is, why it exists, the key
decisions, the tradeoffs, the system map, the outcomes, and what they
would change.

The ONLY evidence available to you is the PROVIDED case study supplied in
the user message. It is the sole source of truth — you MUST NOT introduce
any claim that is not already present in that case study. Loose
hand-waving or invented detail is worse than a shorter, honest tour.

Field rules:
  1. \`area\` is the system/component the tour walks — a single short
     phrase. \`context\` is the problem and constraints, drawn from the
     case study's pitch / decisions.
  2. \`keyDecisions\` re-projects the case study's \`decisions\` as
     decision + rationale pairs (at least one, at most six). Every entry
     must trace to a decision in the provided case study.
  3. \`tradeoffs\` re-projects the case study's \`challenges\` as
     tension / chosenPath / cost triples (at most six). Every entry must
     trace to a challenge in the provided case study.
  4. \`systemMap\` MUST be the case study's \`architecture\` reused
     VERBATIM — copy its diagramFormat, diagramSource, nodes and edges
     exactly. Do NOT invent, redraw, or modify the architecture diagram.
  5. \`outcomes\` re-projects the case study's \`highlights\` (at most
     six). Every entry must trace to a highlight in the provided case
     study.
  6. \`whatIdChange\` is the one new synthesis. It may ONLY cite
     evidenced limitations — things the case study's \`challenges\` or
     \`depthMarkers\` already reveal (e.g. light test coverage, a
     deferred refactor, a known tradeoff cost). If the case study reveals
     no such limitation, return \`[]\` (an empty array). NEVER invent
     regrets, fabricate weaknesses, or speculate beyond the evidence. At
     most four entries.

Speak in the candidate's voice ("I built" / "I chose", never "we
built"). Write the entire tour by emitting the tool below.`;

/**
 * Build the system-tour system prompt. The prompt is grounded purely in
 * the supplied case study; today it does not vary by case-study content,
 * but the signature takes the `CaseStudy` to mirror `buildSystemPrompt`
 * and to leave room for future per-project calibration without a callsite
 * change.
 */
export function buildSystemTourSystemPrompt(_caseStudy: CaseStudy): string {
    void _caseStudy;
    return SYSTEM_PROMPT_TEXT;
}

// ─── Forced tool_use schema ─────────────────────────────────────────────────

const KEY_DECISION_SCHEMA = {
    type: 'object',
    properties: {
        decision:  { type: 'string', minLength: 1, maxLength: 2000 },
        rationale: { type: 'string', minLength: 1, maxLength: 2000 },
    },
    required: ['decision', 'rationale'],
    additionalProperties: false,
};

const TRADEOFF_SCHEMA = {
    type: 'object',
    properties: {
        tension:    { type: 'string', minLength: 1, maxLength: 2000 },
        chosenPath: { type: 'string', minLength: 1, maxLength: 2000 },
        cost:       { type: 'string', minLength: 1, maxLength: 2000 },
    },
    required: ['tension', 'chosenPath', 'cost'],
    additionalProperties: false,
};

const ARCHITECTURE_SCHEMA = {
    type: 'object',
    properties: {
        diagramFormat: { type: 'string', enum: ['mermaid', 'svg'] },
        diagramSource: { type: 'string', minLength: 1 },
        nodes: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id:    { type: 'string' },
                    label: { type: 'string' },
                    kind:  { type: 'string', enum: [...PROJECT_COMPONENT_KINDS] },
                },
                required: ['id', 'label', 'kind'],
                additionalProperties: false,
            },
        },
        edges: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    from:  { type: 'string' },
                    to:    { type: 'string' },
                    label: { type: 'string' },
                },
                required: ['from', 'to'],
                additionalProperties: false,
            },
        },
    },
    required: ['diagramFormat', 'diagramSource', 'nodes', 'edges'],
    additionalProperties: false,
};

export const SYSTEM_TOUR_TOOL = {
    name: 'emit_system_tour',
    description:
        'Emit the interview-ready system tour for a single project, ' +
        're-projected verbatim from the provided case study.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            area:    { type: 'string', minLength: 1, maxLength: 200 },
            context: { type: 'string', minLength: 1, maxLength: 2000 },
            keyDecisions: {
                type: 'array',
                minItems: 1, maxItems: 6,
                items: KEY_DECISION_SCHEMA,
            },
            tradeoffs: {
                type: 'array',
                maxItems: 6,
                items: TRADEOFF_SCHEMA,
            },
            systemMap: ARCHITECTURE_SCHEMA,
            outcomes: {
                type: 'array',
                maxItems: 6,
                items: { type: 'string', minLength: 1, maxLength: 2000 },
            },
            whatIdChange: {
                type: 'array',
                maxItems: 4,
                items: { type: 'string', minLength: 1, maxLength: 2000 },
            },
        },
        required: [
            'area', 'context', 'keyDecisions', 'tradeoffs',
            'systemMap', 'outcomes', 'whatIdChange',
        ],
        additionalProperties: false as const,
    },
};

// ─── Parse + validate (fail-fast) ────────────────────────────────────────────

/**
 * Parse the forced-tool JSON response and validate it against
 * `SystemTourSchema`. Throws on any schema violation — we never persist a
 * partially-valid tour (structure-output-checklist §6/§7). Mirrors the
 * case-study agent's exact validate/throw style.
 */
export function parseSystemTourResponse(text: string): SystemTour {
    const raw = parseJsonResponse<unknown>(text, 'project-system-tour');
    const parsed = SystemTourSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(
            `system-tour output failed schema: ${parsed.error.message}`,
        );
    }
    return parsed.data;
}

// ─── User message ───────────────────────────────────────────────────────────

function buildUserMessage(caseStudy: CaseStudy): string {
    return [
        '<caseStudy>',
        JSON.stringify(caseStudy),
        '</caseStudy>',
        '',
        'This case study is your ONLY evidence. Re-project it into a system',
        'tour: reuse `architecture` verbatim as `systemMap`, and restrict',
        '`whatIdChange` to evidenced limitations (return [] if none).',
        '',
        `Emit the ${SYSTEM_TOUR_TOOL.name} tool now.`,
    ].join('\n');
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

export interface SystemTourAgent {
    invoke(
        caseStudy: CaseStudy,
        ctx:       BasePipelineContext,
    ): Promise<AgentResult<SystemTour>>;
}

export const bedrockSystemTourAgent: SystemTourAgent = {
    async invoke(caseStudy, ctx) {
        const config: AgentConfig = {
            agentName:      'project-system-tour',
            modelId:        EFFECTIVE_MODEL_ID,
            maxTokens:      SYSTEM_TOUR_MAX_TOKENS,
            thinkingBudget: SYSTEM_TOUR_THINKING_BUDGET,
            systemPrompt:   [{ text: buildSystemTourSystemPrompt(caseStudy) }],
            pipeline:       'project-system-tour',
            promptId:       'project-system-tour-v1',
            tool:           SYSTEM_TOUR_TOOL,
        };

        return runAgent<SystemTour>({
            config,
            userMessage:     buildUserMessage(caseStudy),
            pipelineContext: ctx,
            parseResponse:   parseSystemTourResponse,
        });
    },
};
