/**
 * @format
 * Interview Coach Agent — Stage-Specific Preparation
 *
 * Third and final agent in the strategist pipeline. Receives the
 * Strategist Agent's full XML analysis and produces targeted
 * interview preparation for the current stage.
 *
 * Uses Haiku 4.5 — fast and conversational, optimised for
 * structured coaching output.
 *
 * Pipeline position: API → Research → Strategist → **Coach** → DynamoDB
 */

import { z } from 'zod';
import { BaseAgent, parseJsonResponse, log } from '@bedrock/shared';
import { COACH_PERSONA_SYSTEM_PROMPT } from '../prompts/coach-persona.js';
import type {
    AgentConfig,
    AgentResult,
    StrategistPipelineContext,
    StrategistAnalysisResult,
    InterviewCoachResult,
} from '@bedrock/shared';

// =============================================================================
// INPUT TYPE
// =============================================================================

/**
 * Typed input for the Interview Coach Agent.
 *
 * Contains the Strategist Agent's full XML analysis output.
 */
export interface CoachAgentInput {
    /** Strategist Agent's analysis containing the full XML */
    readonly analysis: StrategistAnalysisResult;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Coach model — Haiku 4.5 for fast, conversational output */
const COACH_MODEL = process.env.COACH_MODEL ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * Application Inference Profile ARN — enables granular FinOps cost attribution.
 * When set, used as the model ID for Bedrock invocation instead of the raw model ID.
 */
const EFFECTIVE_MODEL_ID = process.env.INFERENCE_PROFILE_ARN ?? COACH_MODEL;

/** Maximum output tokens */
const COACH_MAX_TOKENS = 8192;

/**
 * Thinking budget. Forced tool_use (constrained decoding) is incompatible
 * with extended thinking on Claude, so the coach trades thinking for a
 * guaranteed schema-compliant payload. See structure-output-checklist §2.
 */
const COACH_THINKING_BUDGET = 0;

// =============================================================================
// STRUCTURED OUTPUT — tool schema + Zod safety-net
// =============================================================================

const INTERVIEW_QUESTION_SCHEMA = {
    type: 'object',
    properties: {
        question:        { type: 'string' },
        answerFramework: { type: 'string' },
        sourceProject:   { type: 'string' },
        difficulty:      { type: 'string', enum: ['easy', 'medium', 'hard'] },
        keyPoints:       { type: 'array', items: { type: 'string' } },
    },
    required: ['question', 'answerFramework', 'sourceProject', 'difficulty', 'keyPoints'],
    additionalProperties: false,
};

/** Tool the model is forced to call — input is the coaching brief. */
const COACH_TOOL = {
    name: 'emit_interview_coaching',
    description: 'Emit the structured, stage-specific interview coaching brief.',
    inputSchema: {
        type: 'object',
        properties: {
            stageDescription:     { type: 'string' },
            technicalQuestions:   { type: 'array', items: INTERVIEW_QUESTION_SCHEMA },
            behaviouralQuestions: { type: 'array', items: INTERVIEW_QUESTION_SCHEMA },
            difficultQuestions: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        question:        { type: 'string' },
                        answerFramework: { type: 'string' },
                        bridgeStrategy:  { type: 'string' },
                    },
                    required: ['question', 'answerFramework', 'bridgeStrategy'],
                    additionalProperties: false,
                },
            },
            technicalPrepChecklist: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        topic:              { type: 'string' },
                        priority:           { type: 'string', enum: ['high', 'medium', 'low'] },
                        rationale:          { type: 'string' },
                        suggestedResources: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['topic', 'priority', 'rationale', 'suggestedResources'],
                    additionalProperties: false,
                },
            },
            questionsToAsk: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        question:  { type: 'string' },
                        rationale: { type: 'string' },
                    },
                    required: ['question', 'rationale'],
                    additionalProperties: false,
                },
            },
            coachingNotes: { type: 'string' },
        },
        required: [
            'stageDescription', 'technicalQuestions', 'behaviouralQuestions',
            'difficultQuestions', 'technicalPrepChecklist', 'questionsToAsk', 'coachingNotes',
        ],
        additionalProperties: false,
    },
};

const InterviewQuestionSchema = z.object({
    question:        z.string(),
    answerFramework: z.string(),
    sourceProject:   z.string(),
    difficulty:      z.enum(['easy', 'medium', 'hard']),
    keyPoints:       z.array(z.string()),
}).strict();

/**
 * Runtime safety-net. `stage` is injected from pipeline context (not model
 * output) so it is omitted here. `.strict()` mirrors additionalProperties:false.
 */
const CoachOutputSchema = z.object({
    stageDescription:     z.string(),
    technicalQuestions:   z.array(InterviewQuestionSchema),
    behaviouralQuestions: z.array(InterviewQuestionSchema),
    difficultQuestions:   z.array(z.object({
        question:        z.string(),
        answerFramework: z.string(),
        bridgeStrategy:  z.string(),
    }).strict()),
    technicalPrepChecklist: z.array(z.object({
        topic:              z.string(),
        priority:           z.enum(['high', 'medium', 'low']),
        rationale:          z.string(),
        suggestedResources: z.array(z.string()),
    }).strict()),
    questionsToAsk: z.array(z.object({
        question:  z.string(),
        rationale: z.string(),
    }).strict()),
    coachingNotes: z.string(),
}).strict();

// =============================================================================
// USER MESSAGE BUILDER
// =============================================================================

/**
 * Build the user message for the Interview Coach Agent.
 *
 * Includes the full XML analysis and the target interview stage
 * so the coach can tailor preparation accordingly.
 *
 * @param analysis - The Strategist Agent's XML analysis output
 * @param ctx - Pipeline context with interview stage
 * @returns Formatted user message
 */
function buildCoachMessage(
    analysis: StrategistAnalysisResult,
    ctx: StrategistPipelineContext,
): string {
    const sections: string[] = [
        `## Interview Stage: ${ctx.interviewStage}`,
        `Target Role: ${ctx.targetRole}`,
        `Target Company: ${ctx.targetCompany}`,
        `Overall Fit: ${analysis.metadata.overallFitRating}`,
        `Recommendation: ${analysis.metadata.applicationRecommendation}`,
        '',
        '## Full Analysis',
        '--- BEGIN ANALYSIS ---',
        analysis.analysisXml,
        '--- END ANALYSIS ---',
        '',
        `Prepare interview coaching for the "${ctx.interviewStage}" stage. ` +
        'Use ONLY verified skills and projects from the analysis. ' +
        'Return the JSON coaching brief.',
    ];

    return sections.join('\n');
}

// =============================================================================
// COACH AGENT CLASS
// =============================================================================

/** Agent configuration for the Interview Coach Agent. */
const COACH_CONFIG: AgentConfig = {
    agentName: 'strategist-coach',
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: COACH_MAX_TOKENS,
    thinkingBudget: COACH_THINKING_BUDGET,
    systemPrompt: COACH_PERSONA_SYSTEM_PROMPT,
    tool: COACH_TOOL,
};

/**
 * Interview Coach Agent — Stage-specific interview preparation.
 *
 * Extends {@link BaseAgent} to encapsulate the Coach lifecycle:
 * - Receives the Strategist's full XML analysis
 * - Produces targeted coaching for the current interview stage
 * - Uses Haiku 4.5 for fast, conversational output
 *
 * @example
 * ```typescript
 * const result = await coachAgent.execute({ analysis }, ctx);
 * ```
 */
class CoachAgent extends BaseAgent<CoachAgentInput, InterviewCoachResult, StrategistPipelineContext> {
    protected readonly agentName = 'strategist-coach' as const;

    /**
     * Build coach configuration.
     *
     * @returns Static coach agent configuration
     */
    protected getConfig(): AgentConfig {
        return COACH_CONFIG;
    }

    /**
     * Build the user message for interview coaching.
     *
     * @param input - Coach input with analysis result
     * @param ctx   - Pipeline context with interview stage
     * @returns Formatted user message for Bedrock
     */
    protected buildUserMessage(input: CoachAgentInput, ctx: StrategistPipelineContext): string {
        return buildCoachMessage(input.analysis, ctx);
    }

    /**
     * Parse the raw LLM text into a typed InterviewCoachResult.
     *
     * Uses `ctx.interviewStage` to inject the stage into the parsed
     * result — previously achieved via a closure.
     *
     * @param responseText - Raw text response from Bedrock
     * @param _input       - Unused (coach doesn't need input in parser)
     * @param ctx          - Pipeline context for interview stage
     * @returns Validated coaching result
     */
    protected parseResponse(
        responseText: string,
        _input: CoachAgentInput,
        ctx: StrategistPipelineContext,
    ): InterviewCoachResult {
        // responseText is the forced tool_use input serialised as JSON.
        // parseJsonResponse handles the unwrap; the Zod safety-net then
        // guarantees the shape before it reaches DynamoDB (fail-fast,
        // structure-output-checklist §7). `stage` is authoritative from
        // pipeline context, not model output.
        const raw = parseJsonResponse<unknown>(responseText, 'strategist-coach');
        const validated = CoachOutputSchema.safeParse(raw);
        if (!validated.success) {
            throw new Error(
                `strategist-coach: coaching output failed schema validation: ${validated.error.message}`,
            );
        }

        return {
            ...validated.data,
            stage: ctx.interviewStage,
        } as InterviewCoachResult;
    }

    /**
     * Pre-execution hook — logs coaching context.
     *
     * @param _input - Unused
     * @param ctx    - Pipeline context
     */
    protected override beforeExecute(_input: CoachAgentInput, ctx: StrategistPipelineContext): void {
        log('INFO', 'Preparing coaching', {
            agent: 'strategist-coach',
            pipelineId: ctx.pipelineId,
            interviewStage: ctx.interviewStage,
            targetRole: ctx.targetRole,
        });
    }

    /**
     * Post-execution hook — logs coaching output.
     *
     * @param result - Coach agent result
     */
    protected override afterExecute(result: AgentResult<InterviewCoachResult>): void {
        log('INFO', 'Coaching prepared', {
            agent: 'strategist-coach',
            stage: result.data.stage,
            technical: result.data.technicalQuestions.length,
            behavioural: result.data.behaviouralQuestions.length,
            difficult: result.data.difficultQuestions.length,
        });
    }
}

/** Module-level singleton — re-used across Lambda invocations. */
const coachAgent = new CoachAgent();

/** Export the agent instance for direct usage. */
export { coachAgent, CoachAgent };

/**
 * Execute the Interview Coach Agent.
 *
 * Backward-compatible wrapper that delegates to the
 * {@link CoachAgent} class instance.
 *
 * @param ctx - Pipeline context with interview stage
 * @param analysis - Strategist Agent's analysis output
 * @returns Interview coaching result with stage-specific preparation
 */
export async function executeCoachAgent(
    ctx: StrategistPipelineContext,
    analysis: StrategistAnalysisResult,
): Promise<AgentResult<InterviewCoachResult>> {
    return coachAgent.execute({ analysis }, ctx);
}
