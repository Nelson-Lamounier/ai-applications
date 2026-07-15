/**
 * @format
 * Strategist Skills Agent -- dedicated Sonnet call composing the candidate's
 * ledger-verified/transferable skills into a JD-tailored Skills section,
 * forced through the `emit_skills` tool (constrained decoding -- see
 * structure-output-checklist section 2). The model may only name tools it was
 * handed in the Skill Evidence Ledger -- validateSkillsMembership (see
 * skills-validate.ts) enforces that contract downstream of this call, with
 * deterministicSkills as the ledger-only fallback.
 */
import {
    runAgent,
    parseJsonResponse,
    type AgentConfig,
    type AgentName,
    type AgentResult,
    type StrategistPipelineContext,
} from '@bedrock/shared';
import { STRATEGIST_SKILLS_META, STRATEGIST_SKILLS_SYSTEM_PROMPT } from '../../prompts/strategist-skills.js';
import { SkillsAgentOutputSchema, SKILLS_EMIT_INPUT_SCHEMA, type SkillsAgentOutput } from './skills-schema.js';
import { buildSkillsMessage, type SkillsMessageInput } from './skills-message.js';

/** Sonnet by default -- nuanced multi-section structured output; never Haiku. */
const SKILLS_MODEL = process.env['STRATEGIST_MODEL'] ?? 'eu.anthropic.claude-sonnet-4-6';
const EFFECTIVE_MODEL_ID = process.env['INFERENCE_PROFILE_ARN'] ?? SKILLS_MODEL;

/**
 * Agent configuration for the Strategist Skills Agent.
 *
 * Forced tool + thinkingBudget 0: constrained decoding, mirroring the
 * projects/experience agents. 'strategist-skills' is not yet in the shared
 * AgentName union -- cast until Task 6 adds it (mirrors strategist-analysis's
 * interim cast in analysis-agent.ts).
 */
const SKILLS_CONFIG: AgentConfig = {
    agentName: 'strategist-skills' as AgentName, // Task 6 adds to union
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: 1500,
    thinkingBudget: 0,
    systemPrompt: STRATEGIST_SKILLS_SYSTEM_PROMPT,
    pipeline: 'job-strategist',
    promptId: STRATEGIST_SKILLS_META.id,
    promptVersion: STRATEGIST_SKILLS_META.version,
    tool: {
        name: 'emit_skills',
        description: 'Emit the tailored skills section -- categories of ledger-grounded skill names.',
        inputSchema: SKILLS_EMIT_INPUT_SCHEMA,
    },
};

/**
 * Execute the Strategist Skills Agent.
 *
 * @param ctx   - Pipeline context (token/cost accumulation)
 * @param input - Focused skills-agent input (JD required/preferred skills,
 *                verified + partial match evidence, technology inventory)
 * @param opts  - Optional agent-name override (cost isolation for a future
 *                re-write pass, mirrors the projects/experience agents)
 * @returns The tailored skill categories
 */
export async function executeSkillsAgent(
    ctx: StrategistPipelineContext,
    input: SkillsMessageInput,
    opts?: { agentName?: AgentName },
): Promise<AgentResult<SkillsAgentOutput>> {
    const config = opts?.agentName ? { ...SKILLS_CONFIG, agentName: opts.agentName } : SKILLS_CONFIG;
    return runAgent<SkillsAgentOutput>({
        config,
        userMessage: buildSkillsMessage(input),
        parseResponse: (text) => SkillsAgentOutputSchema.parse(parseJsonResponse<unknown>(text, 'strategist-skills')),
        pipelineContext: {
            pipelineId: ctx.pipelineId,
            environment: ctx.environment,
            cumulativeTokens: ctx.cumulativeTokens,
            cumulativeCostUsd: ctx.cumulativeCostUsd,
        },
    });
}
