/**
 * @format
 * Strategist Summary Agent — dedicated Sonnet call producing the resume
 * professional summary as four beats (S1-S4), forced through the
 * `emit_summary` tool (constrained decoding — see structure-output-checklist
 * §2). The system, not the model, assembles the beats into the final
 * summary string (assembleSummary).
 */
import {
    runAgent,
    parseJsonResponse,
    type AgentConfig,
    type AgentResult,
    type StrategistPipelineContext,
} from '@bedrock/shared';
import { STRATEGIST_SUMMARY_META, STRATEGIST_SUMMARY_SYSTEM_PROMPT } from '../../prompts/strategist-summary.js';
import { SummaryBeatsSchema, SUMMARY_EMIT_INPUT_SCHEMA, assembleSummary, type SummaryBeats } from './summary-schema.js';
import { buildSummaryMessage, type SummaryMessageInput } from './summary-message.js';

/** Sonnet by default — nuanced multi-section structured output; never Haiku. */
const SUMMARY_MODEL = process.env['STRATEGIST_MODEL'] ?? 'eu.anthropic.claude-sonnet-4-6';
const EFFECTIVE_MODEL_ID = process.env['INFERENCE_PROFILE_ARN'] ?? SUMMARY_MODEL;

/**
 * Agent configuration for the Strategist Summary Agent.
 *
 * thinkingBudget 0: forced tool_use (constrained decoding) is incompatible
 * with extended thinking on Claude. See structure-output-checklist §2.
 */
const SUMMARY_CONFIG: AgentConfig = {
    agentName: 'strategist-summary',
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: 2000,
    thinkingBudget: 0,
    systemPrompt: STRATEGIST_SUMMARY_SYSTEM_PROMPT,
    pipeline: 'job-strategist',
    promptId: STRATEGIST_SUMMARY_META.id,
    promptVersion: STRATEGIST_SUMMARY_META.version,
    tool: {
        name: 'emit_summary',
        description: 'Emit the resume professional summary as four beats s1..s4.',
        inputSchema: SUMMARY_EMIT_INPUT_SCHEMA,
    },
};

/**
 * Execute the Strategist Summary Agent.
 *
 * @param ctx   - Pipeline context (token/cost accumulation)
 * @param input - Focused summary-agent input (research verdicts, finished
 *                resume body, profile intelligence, years-gap framing,
 *                achievement evidence)
 * @returns The four beats plus the assembled summary string
 */
export async function executeSummaryAgent(
    ctx: StrategistPipelineContext,
    input: SummaryMessageInput,
): Promise<AgentResult<{ summary: string; beats: SummaryBeats }>> {
    return runAgent<{ summary: string; beats: SummaryBeats }>({
        config: SUMMARY_CONFIG,
        userMessage: buildSummaryMessage(input),
        parseResponse: (text) => {
            const raw = parseJsonResponse<unknown>(text, 'strategist-summary');
            const beats = SummaryBeatsSchema.parse(raw);
            return { beats, summary: assembleSummary(beats) };
        },
        pipelineContext: {
            pipelineId: ctx.pipelineId,
            environment: ctx.environment,
            cumulativeTokens: ctx.cumulativeTokens,
            cumulativeCostUsd: ctx.cumulativeCostUsd,
        },
    });
}
