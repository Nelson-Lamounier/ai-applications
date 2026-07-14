/**
 * @format
 * Strategist Experience Agent -- dedicated Sonnet call rewriting the
 * candidate's indexed career lines into a JD-tailored Experience section,
 * forced through the `emit_experience` tool (constrained decoding -- see
 * structure-output-checklist section 2). Every bullet's `sources` cites the source
 * line id(s) it was rewritten from; every input line must be accounted for
 * (cited or dropped with a reason) -- the provenance contract enforced by
 * ExperienceAgentOutputSchema.
 */
import {
    runAgent,
    parseJsonResponse,
    type AgentConfig,
    type AgentName,
    type AgentResult,
    type StrategistPipelineContext,
} from '@bedrock/shared';
import { STRATEGIST_EXPERIENCE_META, STRATEGIST_EXPERIENCE_SYSTEM_PROMPT } from '../../prompts/strategist-experience.js';
import { ExperienceAgentOutputSchema, EXPERIENCE_EMIT_INPUT_SCHEMA, type ExperienceAgentOutput } from './experience-schema.js';
import { buildExperienceMessage, type ExperienceMessageInput } from './experience-message.js';

/** Sonnet by default -- nuanced multi-section structured output; never Haiku. */
const EXPERIENCE_MODEL = process.env['STRATEGIST_MODEL'] ?? 'eu.anthropic.claude-sonnet-4-6';
const EFFECTIVE_MODEL_ID = process.env['INFERENCE_PROFILE_ARN'] ?? EXPERIENCE_MODEL;

/**
 * Agent configuration for the Strategist Experience Agent.
 *
 * Forced tool + thinkingBudget 0: constrained decoding, and the payload can
 * safely carry the metrics ledger (the 2026-07-08 thinking blowup applied to
 * the extended-thinking writer, not forced-tool calls).
 */
const EXPERIENCE_CONFIG: AgentConfig = {
    agentName: 'strategist-experience',
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: 4000,
    thinkingBudget: 0,
    systemPrompt: STRATEGIST_EXPERIENCE_SYSTEM_PROMPT,
    pipeline: 'job-strategist',
    promptId: STRATEGIST_EXPERIENCE_META.id,
    promptVersion: STRATEGIST_EXPERIENCE_META.version,
    tool: {
        name: 'emit_experience',
        description: 'Emit the tailored experience section with per-bullet source citations and line accounting.',
        inputSchema: EXPERIENCE_EMIT_INPUT_SCHEMA,
    },
};

/**
 * Execute the Strategist Experience Agent.
 *
 * @param ctx   - Pipeline context (token/cost accumulation)
 * @param input - Focused experience-agent input (indexed career lines, ATS
 *                targets, verified-match evidence, grounded metrics, code
 *                stack, and -- on a re-write pass -- the previous draft)
 * @param opts  - Optional agent-name override (the ATS re-write pass books
 *                under 'strategist-experience-rewrite' for cost isolation)
 * @returns The tailored roles plus the line-accounting ledger
 */
export async function executeExperienceAgent(
    ctx: StrategistPipelineContext,
    input: ExperienceMessageInput,
    opts?: { agentName?: AgentName },
): Promise<AgentResult<ExperienceAgentOutput>> {
    const config = opts?.agentName ? { ...EXPERIENCE_CONFIG, agentName: opts.agentName } : EXPERIENCE_CONFIG;
    return runAgent<ExperienceAgentOutput>({
        config,
        userMessage: buildExperienceMessage(input),
        parseResponse: (text) => ExperienceAgentOutputSchema.parse(parseJsonResponse<unknown>(text, 'strategist-experience')),
        pipelineContext: {
            pipelineId: ctx.pipelineId,
            environment: ctx.environment,
            cumulativeTokens: ctx.cumulativeTokens,
            cumulativeCostUsd: ctx.cumulativeCostUsd,
        },
    });
}
