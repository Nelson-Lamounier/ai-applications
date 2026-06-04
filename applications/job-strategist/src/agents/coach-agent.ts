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
import { BaseAgent, parseJsonResponse, log, validateSkillTransfer } from '@bedrock/shared';
import { assembleCoachSystemPrompt } from '../prompts/coach/stages/index.js';
import type {
    AgentConfig,
    AgentResult,
    StrategistPipelineContext,
    StrategistAnalysisResult,
    InterviewCoachResult,
    SkillCandidateSet,
    SkillTransferEntry,
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
    /** Optional stage-prep calibration block appended to the user message (phone-screen). */
    readonly constraintBlock?: string;
    /** Verified-evidence digest from the Research result (phone-screen grounding). */
    readonly evidenceBlock?: string;
    /** Pre-serialised candidate block (from buildSkillCandidateBlock). */
    readonly skillCandidateBlock?: string;
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

/**
 * Maximum output tokens. Raised from 8192 → 16384 (env-overridable): the coach
 * now receives a grounded Research evidence digest + career-history constraints,
 * so phone-screen output (career arc, JD talking points, comp script + the
 * question sets) exceeds the old 8192 ceiling and truncates (stopReason=max_tokens).
 */
const COACH_MAX_TOKENS = parseInt(process.env.COACH_MAX_TOKENS ?? '16384', 10);

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
            skillTransfer: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        jdSkill:     { type: 'string' },
                        tier:        { type: 'string', enum: ['demonstrated', 'claimed', 'declared', 'gap'] },
                        projectId:   { type: ['string', 'null'] },
                        projectName: { type: ['string', 'null'] },
                        evidenceRefs: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: { source: { type: 'string' }, id: { type: 'string' }, label: { type: 'string' }, fileLine: { type: 'string' } },
                                required: ['source', 'id', 'label'],
                                additionalProperties: false,
                            },
                        },
                        narrative:   { type: 'string' },
                    },
                    required: ['jdSkill', 'tier', 'projectId', 'projectName', 'evidenceRefs', 'narrative'],
                    additionalProperties: false,
                },
            },
            careerArcSummary: { type: 'string' },
            jdTalkingPoints: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        point:    { type: 'string' },
                        evidence: { type: 'string' },
                    },
                    required: ['point', 'evidence'],
                    additionalProperties: false,
                },
            },
            compScript: {
                type: 'object',
                properties: {
                    targetEcho:      { type: 'string' },
                    marketContext:   { type: ['string', 'null'] },
                    deflectTemplate: { type: 'string' },
                },
                required: ['targetEcho', 'marketContext', 'deflectTemplate'],
                additionalProperties: false,
            },
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
export const CoachOutputSchema = z.object({
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
    skillTransfer: z.array(z.object({
        jdSkill:     z.string(),
        tier:        z.enum(['demonstrated', 'claimed', 'declared', 'gap']),
        projectId:   z.string().nullable(),
        projectName: z.string().nullable(),
        evidenceRefs: z.array(z.object({
            source: z.string(), id: z.string(), label: z.string(), fileLine: z.string().optional(),
        }).strict()),
        narrative:   z.string(),
    }).strict()).optional(),
    careerArcSummary: z.string().optional(),
    jdTalkingPoints: z.array(z.object({
        point:    z.string(),
        evidence: z.string(),
    }).strict()).optional(),
    compScript: z.object({
        targetEcho:      z.string(),
        marketContext:   z.string().nullable(),
        deflectTemplate: z.string(),
    }).strict().optional(),
}).strict();

// =============================================================================
// SKILL CANDIDATE BLOCK SERIALISER
// =============================================================================

/** Render candidate sets as a compact, id-bearing block the model must cite from. */
export function buildSkillCandidateBlock(sets: readonly SkillCandidateSet[]): string {
    if (sets.length === 0) return '';
    const lines = ['## Candidate project evidence per JD skill (cite ONLY these ids)'];
    for (const s of sets) {
        if (s.candidates.length === 0) { lines.push(`- ${s.jdSkill}: (no project evidence → tier=gap)`); continue; }
        lines.push(`- ${s.jdSkill}:`);
        for (const c of s.candidates) {
            lines.push(`    [${c.tier}] project=${c.projectId} (${c.projectName}) source=${c.source} id=${c.id} :: ${c.label}${c.fileLine ? ` @${c.fileLine}` : ''}`);
        }
    }
    lines.push(
        'For EACH JD skill above, emit one skillTransfer entry. Pick the single best candidate ' +
        '(prefer demonstrated > declared > claimed); set projectId/projectName/evidenceRefs to that ' +
        "candidate's exact ids; narrate how the project work transfers to the JD skill. If a skill " +
        'has no candidates, emit tier="gap", projectId=null, evidenceRefs=[], and honest bridge guidance. ' +
        'NEVER cite an id not listed above. Also reference the matched project in any related ' +
        'technicalPrepChecklist rationale.',
    );
    return lines.join('\n');
}

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
    constraintBlock?: string,
    evidenceBlock?: string,
    skillCandidateBlock?: string,
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
    ];
    if (evidenceBlock) {
        sections.push('## Verified Evidence (from Research)', evidenceBlock, '');
    }
    if (constraintBlock) {
        sections.push(constraintBlock, '');
    }
    if (skillCandidateBlock) {
        sections.push(skillCandidateBlock, '');
    }
    sections.push(
        `Prepare interview coaching for the "${ctx.interviewStage}" stage. ` +
        'Use ONLY verified skills and projects from the analysis. ' +
        'Return the JSON coaching brief.',
    );
    return sections.join('\n');
}

// =============================================================================
// COACH AGENT CLASS
// =============================================================================

/**
 * Phone-screen-only output fields. Optional in the shared schema (other stages
 * must omit them) but REQUIRED for phone-screen via a stage-specific tool so the
 * model can't silently drop them under output pressure (observed: jdTalkingPoints
 * omitted while careerArc/compScript emitted). Forced tool_use + required = guaranteed.
 */
export const PHONE_SCREEN_FIELDS = ['careerArcSummary', 'jdTalkingPoints', 'compScript'] as const;

/** Return the coach tool with phone-screen fields promoted to `required` for that stage. */
export function coachToolForStage(stage: string): typeof COACH_TOOL {
    if (stage !== 'phone-screen') return COACH_TOOL;
    return {
        ...COACH_TOOL,
        inputSchema: {
            ...COACH_TOOL.inputSchema,
            required: [...COACH_TOOL.inputSchema.required, ...PHONE_SCREEN_FIELDS],
        },
    };
}

/** Agent configuration for the Interview Coach Agent. */
const COACH_CONFIG: Omit<AgentConfig, 'systemPrompt'> = {
    agentName: 'strategist-coach',
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: COACH_MAX_TOKENS,
    thinkingBudget: COACH_THINKING_BUDGET,
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
     * Build coach configuration. Stage-aware: phone-screen uses a tool variant
     * that requires the phone-screen fields, guaranteeing the model emits them.
     *
     * @param _input - Unused
     * @param ctx    - Pipeline context (interview stage)
     * @returns Coach agent configuration for this stage
     */
    protected getConfig(_input: CoachAgentInput, ctx: StrategistPipelineContext): AgentConfig {
        return {
            ...COACH_CONFIG,
            systemPrompt: assembleCoachSystemPrompt(ctx.interviewStage),
            tool: coachToolForStage(ctx.interviewStage),
        };
    }

    /**
     * Build the user message for interview coaching.
     *
     * @param input - Coach input with analysis result
     * @param ctx   - Pipeline context with interview stage
     * @returns Formatted user message for Bedrock
     */
    protected buildUserMessage(input: CoachAgentInput, ctx: StrategistPipelineContext): string {
        return buildCoachMessage(input.analysis, ctx, input.constraintBlock, input.evidenceBlock, input.skillCandidateBlock);
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
    constraintBlock?: string,
    evidenceBlock?: string,
    skillCandidateSets?: readonly SkillCandidateSet[],
): Promise<AgentResult<InterviewCoachResult>> {
    const skillCandidateBlock = buildSkillCandidateBlock(skillCandidateSets ?? []);
    const result = await coachAgent.execute({ analysis, constraintBlock, evidenceBlock, skillCandidateBlock }, ctx);
    if (skillCandidateSets && skillCandidateSets.length > 0) {
        const raw = (result.data.skillTransfer ?? []) as SkillTransferEntry[];
        (result.data as { skillTransfer?: unknown }).skillTransfer = validateSkillTransfer(raw, skillCandidateSets);
    }
    return result;
}
