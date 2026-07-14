/**
 * @format
 * Strategist Projects Agent -- dedicated Sonnet call composing the
 * candidate's documented projects into a JD-tailored Projects section,
 * forced through the `emit_projects` tool (constrained decoding -- see
 * structure-output-checklist section 2). The two-lane pool splits curated
 * case-study bullets (quote-only, selected by id) from repo-current evidence
 * facts (composable, capped at 2 per project, cited by id) -- the contract
 * enforced by ProjectsAgentOutputSchema.
 */
import {
    runAgent,
    parseJsonResponse,
    type AgentConfig,
    type AgentName,
    type AgentResult,
    type StrategistPipelineContext,
} from '@bedrock/shared';
import { STRATEGIST_PROJECTS_META, STRATEGIST_PROJECTS_SYSTEM_PROMPT } from '../../prompts/strategist-projects.js';
import { ProjectsAgentOutputSchema, PROJECTS_EMIT_INPUT_SCHEMA, type ProjectsAgentOutput } from './projects-schema.js';
import { buildProjectsMessage, type ProjectsMessageInput } from './projects-message.js';

/** Sonnet by default -- nuanced multi-section structured output; never Haiku. */
const PROJECTS_MODEL = process.env['STRATEGIST_MODEL'] ?? 'eu.anthropic.claude-sonnet-4-6';
const EFFECTIVE_MODEL_ID = process.env['INFERENCE_PROFILE_ARN'] ?? PROJECTS_MODEL;

/**
 * Agent configuration for the Strategist Projects Agent.
 *
 * Forced tool + thinkingBudget 0: constrained decoding, and the payload can
 * safely carry the two-lane pool (the 2026-07-08 thinking blowup applied to
 * the extended-thinking writer, not forced-tool calls).
 */
const PROJECTS_CONFIG: AgentConfig = {
    agentName: 'strategist-projects' as AgentName, // Task 6 adds these to the union
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: 3000,
    thinkingBudget: 0,
    systemPrompt: STRATEGIST_PROJECTS_SYSTEM_PROMPT,
    pipeline: 'job-strategist',
    promptId: STRATEGIST_PROJECTS_META.id,
    promptVersion: STRATEGIST_PROJECTS_META.version,
    tool: {
        name: 'emit_projects',
        description: 'Emit the tailored projects section -- curated bullets by id, composed bullets with fact citations.',
        inputSchema: PROJECTS_EMIT_INPUT_SCHEMA,
    },
};

/**
 * Execute the Strategist Projects Agent.
 *
 * @param ctx   - Pipeline context (token/cost accumulation)
 * @param input - Focused projects-agent input (two-lane project pool,
 *                requirement-grouped ATS targets, target role, and -- on a
 *                re-write pass -- the previous draft)
 * @param opts  - Optional agent-name override (the ATS re-write pass books
 *                under 'strategist-projects-rewrite' for cost isolation)
 * @returns The tailored project entries
 */
export async function executeProjectsAgent(
    ctx: StrategistPipelineContext,
    input: ProjectsMessageInput,
    opts?: { agentName?: AgentName },
): Promise<AgentResult<ProjectsAgentOutput>> {
    const config = opts?.agentName ? { ...PROJECTS_CONFIG, agentName: opts.agentName } : PROJECTS_CONFIG;
    return runAgent<ProjectsAgentOutput>({
        config,
        userMessage: buildProjectsMessage(input),
        parseResponse: (text) => ProjectsAgentOutputSchema.parse(parseJsonResponse<unknown>(text, 'strategist-projects')),
        pipelineContext: {
            pipelineId: ctx.pipelineId,
            environment: ctx.environment,
            cumulativeTokens: ctx.cumulativeTokens,
            cumulativeCostUsd: ctx.cumulativeCostUsd,
        },
    });
}
