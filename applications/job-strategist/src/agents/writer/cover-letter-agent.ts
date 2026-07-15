/**
 * @format
 * Strategist Cover Letter Agent -- dedicated Sonnet call composing the
 * candidate's cover letter, forced through the `emit_cover_letter` tool
 * (constrained decoding -- see structure-output-checklist section 2). The
 * signoff is copied VERBATIM from the Candidate Contact block; the letter's
 * lead must echo the resume body's strongest JD-relevant achievement.
 * `agents/quality/cover-letter-guard.ts` enforces the narrative rules
 * (recruiter-register P1, tenure-conditional, resume-number cap, etc.) on
 * this agent's output downstream of this call -- the persona keeps satisfying
 * that guard's contract.
 */
import {
    runAgent,
    parseJsonResponse,
    type AgentConfig,
    type AgentName,
    type AgentResult,
    type CoverLetter,
    type StrategistPipelineContext,
} from '@bedrock/shared';
import { STRATEGIST_COVER_LETTER_META, STRATEGIST_COVER_LETTER_SYSTEM_PROMPT } from '../../prompts/strategist-cover-letter.js';
import { CoverLetterSchema } from '../../schemas/cover-letter.schema.js';
import { buildCoverLetterMessage, type CoverLetterMessageInput } from './cover-letter-message.js';

/** Sonnet by default -- nuanced multi-section structured output; never Haiku. */
const COVER_LETTER_MODEL = process.env['STRATEGIST_MODEL'] ?? 'eu.anthropic.claude-sonnet-4-6';
const EFFECTIVE_MODEL_ID = process.env['INFERENCE_PROFILE_ARN'] ?? COVER_LETTER_MODEL;

/** Forced-tool input schema for emit_cover_letter -- mirrors CoverLetterSchema (all fields required). */
const COVER_LETTER_EMIT_INPUT_SCHEMA = {
    type: 'object',
    properties: {
        greeting:   { type: 'string' },
        paragraphs: { type: 'array', items: { type: 'string' } },
        signoff: {
            type: 'object',
            properties: {
                name:     { type: 'string' },
                email:    { type: 'string' },
                linkedin: { type: 'string' },
                github:   { type: 'string' },
            },
            required: ['name', 'email', 'linkedin', 'github'],
        },
    },
    required: ['greeting', 'paragraphs', 'signoff'],
} as const;

/**
 * Agent configuration for the Strategist Cover Letter Agent.
 *
 * Forced tool + thinkingBudget 0: constrained decoding, mirroring the
 * skills/projects/experience agents. 'strategist-cover-letter' is not yet in
 * the shared AgentName union -- cast until Task 6 adds it (mirrors
 * strategist-skills's interim cast in skills-agent.ts).
 */
const COVER_LETTER_CONFIG: AgentConfig = {
    agentName: 'strategist-cover-letter' as AgentName, // Task 6 adds to union
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: 1500,
    thinkingBudget: 0,
    systemPrompt: STRATEGIST_COVER_LETTER_SYSTEM_PROMPT,
    pipeline: 'job-strategist',
    promptId: STRATEGIST_COVER_LETTER_META.id,
    promptVersion: STRATEGIST_COVER_LETTER_META.version,
    tool: {
        name: 'emit_cover_letter',
        description: 'Emit the tailored cover letter -- greeting, exactly 3 paragraphs, and the verbatim signoff.',
        inputSchema: COVER_LETTER_EMIT_INPUT_SCHEMA,
    },
};

/**
 * Execute the Strategist Cover Letter Agent.
 *
 * @param ctx   - Pipeline context (token/cost accumulation)
 * @param input - Focused cover-letter-agent input (research brief essentials,
 *                achievement evidence, candidate contact, years-gap framing,
 *                profile intelligence, and the assembled resume-body echo
 *                source -- see cover-letter-message.ts's doc comment for the
 *                batch-2 dependency)
 * @returns The tailored cover letter
 */
export async function executeCoverLetterAgent(
    ctx: StrategistPipelineContext,
    input: CoverLetterMessageInput,
): Promise<AgentResult<CoverLetter>> {
    return runAgent<CoverLetter>({
        config: COVER_LETTER_CONFIG,
        userMessage: buildCoverLetterMessage(input),
        parseResponse: (text) => CoverLetterSchema.parse(parseJsonResponse<unknown>(text, 'strategist-cover-letter')),
        pipelineContext: {
            pipelineId: ctx.pipelineId,
            environment: ctx.environment,
            cumulativeTokens: ctx.cumulativeTokens,
            cumulativeCostUsd: ctx.cumulativeCostUsd,
        },
    });
}
