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
import { ProjectsAgentOutputSchema, PROJECTS_EMIT_INPUT_SCHEMA, normaliseProjectsAgentOutput, type ProjectsAgentOutput } from './projects-schema.js';
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
    agentName: 'strategist-projects',
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
 * @returns The tailored project entries, plus `normalisedExtras` -- the count
 *          of schema-tolerance strips this call's response needed (see
 *          normaliseProjectsAgentOutput; 0 on a clean response).
 */
export async function executeProjectsAgent(
    ctx: StrategistPipelineContext,
    input: ProjectsMessageInput,
    opts?: { agentName?: AgentName },
): Promise<AgentResult<ProjectsAgentOutput> & { readonly normalisedExtras: number }> {
    const config = opts?.agentName ? { ...PROJECTS_CONFIG, agentName: opts.agentName } : PROJECTS_CONFIG;
    // normalise-then-validate: run BEFORE ProjectsAgentOutputSchema.parse so
    // the known-safe bulletId+echoed-sources over-emission (the wire schema
    // allows it; the strict runtime union does not) never zod-rejects a
    // paid-for generation. `normalisedExtras` is captured via this closure
    // because parseResponse runs synchronously inside runAgent, before it
    // resolves -- both the first-draft and the rewrite call share this same
    // parse path (opts.agentName only changes which agent books the spend).
    let normalisedExtras = 0;
    const result = await runAgent<ProjectsAgentOutput>({
        config,
        userMessage: buildProjectsMessage(input),
        parseResponse: (text) => {
            const raw = parseJsonResponse<unknown>(text, 'strategist-projects');
            const normalised = normaliseProjectsAgentOutput(raw);
            normalisedExtras = normalised.normalisedExtras;
            return ProjectsAgentOutputSchema.parse(normalised.output);
        },
        pipelineContext: {
            pipelineId: ctx.pipelineId,
            environment: ctx.environment,
            cumulativeTokens: ctx.cumulativeTokens,
            cumulativeCostUsd: ctx.cumulativeCostUsd,
        },
    });
    return { ...result, normalisedExtras };
}
