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
import { deepStripCdata } from '../lib/strip-cdata.js';
import type {
    AgentConfig,
    AgentResult,
    StrategistPipelineContext,
    StrategistAnalysisResult,
    InterviewCoachResult,
    SkillCandidateSet,
    SkillTransferEntry,
    ConcernCoverage,
    SystemDesignConcern,
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
    /** Pre-serialised system-design concern block (from buildConcernWalkthroughBlock). */
    readonly systemDesignBlock?: string;
    /** Pre-serialised bar-raiser leadership-principle block (from buildBarRaiserBlock). */
    readonly barRaiserBlock?: string;
    /** Career-arc + role-fit context for the final-round prep stage (from buildFinalInputs). */
    readonly finalBlock?: string;
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
 * Maximum output tokens. Raised 8192 → 16384 → 32000 (env-overridable). The
 * grounded coach (Research evidence digest + career constraints) already pushed
 * phone-screen past 8192; the project-anchored System Design walkthrough — one
 * detailed card per JD-relevant concern (articulation, follow-ups, gap guidance),
 * 10+ cards for a rich project — blows past 16384 and truncates
 * (stopReason=max_tokens), which fails the whole run. Sonnet 4.6 supports far
 * more (the strategist runs at 64000), so 32000 gives comfortable headroom.
 */
const COACH_MAX_TOKENS = parseInt(process.env.COACH_MAX_TOKENS ?? '32000', 10);

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

/** Shared evidence-pointer array schema — cited by both skillTransfer and the system-design walkthrough. */
const EVIDENCE_REFS_SCHEMA = {
    type: 'array',
    items: {
        type: 'object',
        properties: { source: { type: 'string' }, id: { type: 'string' }, label: { type: 'string' }, fileLine: { type: 'string' } },
        required: ['source', 'id', 'label'],
        additionalProperties: false,
    },
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
            coachingNotes: {
                type: 'object',
                properties: {
                    positioning: { type: 'string' },
                    interviewFocus: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                label:  { type: 'string' },
                                detail: { type: 'string' },
                            },
                            required: ['label', 'detail'],
                            additionalProperties: false,
                        },
                    },
                    tacticalPrep:    { type: 'string' },
                    communication:   { type: 'string' },
                    mindset:         { type: 'string' },
                    debrief:         { type: 'string' },
                    finalCheckpoint: {
                        type: 'object',
                        properties: {
                            items: { type: 'array', items: { type: 'string' } },
                            note:  { type: 'string' },
                        },
                        required: ['items'],
                        additionalProperties: false,
                    },
                },
                required: ['positioning'],
                additionalProperties: false,
            },
            skillTransfer: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        jdSkill:     { type: 'string' },
                        tier:        { type: 'string', enum: ['demonstrated', 'claimed', 'declared', 'gap'] },
                        projectId:   { type: ['string', 'null'] },
                        projectName: { type: ['string', 'null'] },
                        evidenceRefs: EVIDENCE_REFS_SCHEMA,
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
                        point:         { type: 'string' },
                        evidence:      { type: 'string' },
                        matchedSkills: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['point', 'evidence', 'matchedSkills'],
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
            systemDesignWalkthrough: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        concernId:       { type: 'string' },
                        concernQuestion: { type: 'string' },
                        whyItMatters:    { type: 'string' },
                        evidenceRefs: EVIDENCE_REFS_SCHEMA,
                        choiceMade:   { type: ['string', 'null'] },
                        articulation: { type: 'string' },
                        followUps: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    question: { type: 'string' },
                                    status:   { type: 'string', enum: ['addressed', 'partial', 'gap'] },
                                    framing:  { type: 'string' },
                                },
                                required: ['question', 'status', 'framing'],
                                additionalProperties: false,
                            },
                        },
                        gapGuidance: { type: ['string', 'null'] },
                    },
                    required: ['concernId', 'concernQuestion', 'whyItMatters', 'evidenceRefs', 'choiceMade', 'articulation', 'followUps', 'gapGuidance'],
                    additionalProperties: false,
                },
            },
            barRaiserWalkthrough: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        principleId:    { type: 'string' },
                        principleName:  { type: 'string' },
                        interpretation: { type: 'string' },
                        coverage:       { type: 'string', enum: ['strong', 'partial', 'none'] },
                        stories: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    title:              { type: 'string' },
                                    situation:          { type: 'string' },
                                    task:               { type: 'string' },
                                    action:             { type: 'string' },
                                    result:             { type: 'string' },
                                    evidenceRefs:       EVIDENCE_REFS_SCHEMA,
                                    honestyCalibration: { type: 'string' },
                                    seniorityNote:      { type: 'string' },
                                },
                                required: ['title', 'situation', 'task', 'action', 'result', 'evidenceRefs', 'honestyCalibration', 'seniorityNote'],
                                additionalProperties: false,
                            },
                        },
                        probingQuestions: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    question: { type: 'string' },
                                    framing:  { type: 'string' },
                                },
                                required: ['question', 'framing'],
                                additionalProperties: false,
                            },
                        },
                        gapGuidance: { type: ['string', 'null'] },
                    },
                    required: ['principleId', 'principleName', 'interpretation', 'coverage', 'stories', 'probingQuestions', 'gapGuidance'],
                    additionalProperties: false,
                },
            },
            finalPrep: {
                type: 'object',
                properties: {
                    whyThisRole: { type: 'string' },
                    mutualFitTalkingPoints: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { point: { type: 'string' }, grounding: { type: 'string' } },
                            required: ['point', 'grounding'],
                            additionalProperties: false,
                        },
                    },
                    substantiveQuestions: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { question: { type: 'string' }, rationale: { type: 'string' } },
                            required: ['question', 'rationale'],
                            additionalProperties: false,
                        },
                    },
                    longTermFraming: { type: 'string' },
                },
                required: ['whyThisRole', 'mutualFitTalkingPoints', 'substantiveQuestions', 'longTermFraming'],
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

/** Shared Zod for evidence-pointer arrays — reused by skillTransfer + system-design walkthrough. */
const EvidenceRefsSchema = z.array(z.object({
    source: z.string(), id: z.string(), label: z.string(), fileLine: z.string().optional(),
}).strict());

/** One STAR story within a bar-raiser principle card. */
const BarRaiserStorySchema = z.object({
    title:              z.string(),
    situation:          z.string(),
    task:               z.string(),
    action:             z.string(),
    result:             z.string(),
    evidenceRefs:       EvidenceRefsSchema,
    honestyCalibration: z.string(),
    seniorityNote:      z.string(),
}).strict();

/** One leadership-principle card emitted by the coach (bar-raiser stage). */
const BarRaiserPrincipleSchema = z.object({
    principleId:    z.string(),
    principleName:  z.string(),
    interpretation: z.string(),
    coverage:       z.enum(['strong', 'partial', 'none']),
    stories:        z.array(BarRaiserStorySchema),
    probingQuestions: z.array(z.object({
        question: z.string(),
        framing:  z.string(),
    }).strict()),
    gapGuidance: z.string().nullable(),
}).strict();

/** One mutual-fit talking point within the final-round prep brief. */
const FinalTalkingPointSchema = z.object({
    point:     z.string(),
    grounding: z.string(),
}).strict();

/** One substantive question to ask within the final-round prep brief. */
const FinalQuestionSchema = z.object({
    question:  z.string(),
    rationale: z.string(),
}).strict();

/** Final-round preparation brief emitted by the coach (final-round stage). */
const FinalPrepSchema = z.object({
    whyThisRole:            z.string(),
    mutualFitTalkingPoints: z.array(FinalTalkingPointSchema),
    substantiveQuestions:   z.array(FinalQuestionSchema),
    longTermFraming:        z.string(),
}).strict();

/** One "what to expect" item — short bold label + its description. */
const InterviewFocusItemSchema = z.object({
    label:  z.string(),
    detail: z.string(),
}).strict();

/** Split a legacy markdown checklist into structured items + closing note. */
function coerceCheckpoint(markdown: string): { items: string[]; note?: string } {
    const items: string[] = [];
    const noteLines: string[] = [];
    for (const raw of markdown.split('\n')) {
        const line = raw.trim();
        const match = /^[-*]\s*\[[ xX]?\]\s*(.+)$/.exec(line);
        if (match) {
            const label = match[1].trim();
            if (label.length > 0) items.push(label);
        } else if (line.length > 0) {
            noteLines.push(line);
        }
    }
    const note = noteLines.join('\n').trim();
    return note.length > 0 ? { items, note } : { items };
}

/** Pre-interview checklist — structured items + optional note. */
const FinalCheckpointSchema = z.object({
    items: z.array(z.string()),
    note:  z.string().optional(),
}).strict();

/** Accept the structured object, or coerce a legacy markdown string into it. */
const FinalCheckpointField = z.union([
    FinalCheckpointSchema,
    z.string().transform((s): z.infer<typeof FinalCheckpointSchema> => coerceCheckpoint(s)),
]);

/** Structured stage coaching — mirrors CoachingNotes in @bedrock/shared. */
const CoachingNotesSchema = z.object({
    positioning:     z.string(),
    interviewFocus:  z.array(InterviewFocusItemSchema).optional(),
    tacticalPrep:    z.string().optional(),
    communication:   z.string().optional(),
    mindset:         z.string().optional(),
    debrief:         z.string().optional(),
    finalCheckpoint: FinalCheckpointField.optional(),
}).strict();

/**
 * Accept the structured object (the contract) or — defensively — a bare string
 * the model might still emit, coercing it into `{ positioning }`. Keeps the
 * safety-net from hard-failing on a legacy-shaped tool call.
 */
const CoachingNotesField = z.union([
    CoachingNotesSchema,
    z.string().transform((s): z.infer<typeof CoachingNotesSchema> => ({ positioning: s })),
]);

/**
 * Runtime safety-net. `stage` is injected from pipeline context (not model
 * output) so it is omitted here. `.strict()` mirrors additionalProperties:false.
 */
export const CoachOutputSchema = z.object({
    stageDescription:     z.string(),
    // Stage-specific arrays default to [] when a stage doesn't emit them. The coach
    // produces only the fields its stage needs (behavioural emits behaviouralQuestions,
    // not technicalQuestions; system-design emits systemDesignWalkthrough). A shared
    // schema requiring every array made the model's correct per-stage omissions fail
    // validation — so default rather than require. Keeps afterExecute's `.length`
    // reads safe (always arrays).
    technicalQuestions:   z.array(InterviewQuestionSchema).default([]),
    behaviouralQuestions: z.array(InterviewQuestionSchema).default([]),
    difficultQuestions:   z.array(z.object({
        question:        z.string(),
        answerFramework: z.string(),
        bridgeStrategy:  z.string(),
    }).strict()).default([]),
    technicalPrepChecklist: z.array(z.object({
        topic:              z.string(),
        priority:           z.enum(['high', 'medium', 'low']),
        rationale:          z.string(),
        suggestedResources: z.array(z.string()),
    }).strict()).default([]),
    questionsToAsk: z.array(z.object({
        question:  z.string(),
        rationale: z.string(),
    }).strict()).default([]),
    coachingNotes: CoachingNotesField,
    skillTransfer: z.array(z.object({
        jdSkill:     z.string(),
        tier:        z.enum(['demonstrated', 'claimed', 'declared', 'gap']),
        projectId:   z.string().nullable(),
        projectName: z.string().nullable(),
        evidenceRefs: EvidenceRefsSchema,
        narrative:   z.string(),
    }).strict()).optional(),
    careerArcSummary: z.string().optional(),
    jdTalkingPoints: z.array(z.object({
        point:         z.string(),
        evidence:      z.string(),
        matchedSkills: z.array(z.string()).default([]),
    }).strict()).optional(),
    compScript: z.object({
        targetEcho:      z.string(),
        marketContext:   z.string().nullable(),
        deflectTemplate: z.string(),
    }).strict().optional(),
    systemDesignWalkthrough: z.array(z.object({
        concernId:       z.string(),
        concernQuestion: z.string(),
        whyItMatters:    z.string(),
        evidenceRefs: EvidenceRefsSchema,
        choiceMade:   z.string().nullable(),
        articulation: z.string(),
        followUps: z.array(z.object({
            question: z.string(),
            status:   z.enum(['addressed', 'partial', 'gap']),
            framing:  z.string(),
        }).strict()),
        gapGuidance: z.string().nullable(),
    }).strict()).optional(),
    barRaiserWalkthrough: z.array(BarRaiserPrincipleSchema).optional(),
    finalPrep: FinalPrepSchema.optional(),
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

/** Render detected concerns + their grounded evidence as a block the model must cite from. */
export function buildConcernWalkthroughBlock(
    coverage: ConcernCoverage,
    concerns: readonly SystemDesignConcern[],
): string {
    const byId = new Map(concerns.map(c => [c.concernId, c]));
    const relevant = coverage.detected.filter(d => d.relevantToJd);
    if (relevant.length === 0) return '';
    const lines = ['## System-design concerns for THIS role (emit one walkthrough card per concern, cite ONLY these evidence ids)'];
    for (const d of relevant) {
        const c = byId.get(d.concernId);
        if (!c) continue;
        appendConcernLines(lines, d, c);
    }
    lines.push(
        'For EACH concern: cite ONLY the evidence ids listed for it. Write the articulation in ' +
        'first person ("I chose…"), name the trade-off and the failure mode you avoided. For each ' +
        'follow-up set status addressed/partial/gap against the evidence and give honest framing. ' +
        'Never invent evidence or claim scale not shown. No evidence → honest gap card.',
    );
    return lines.join('\n');
}

/** Append the lines for a single detected concern (kept separate for complexity). */
function appendConcernLines(
    lines: string[],
    d: ConcernCoverage['detected'][number],
    c: SystemDesignConcern,
): void {
    lines.push(`- [${d.strength}] ${d.concernId}: ${c.concernQuestion}`);
    lines.push(`    why: ${c.whyInterviewersAsk}`);
    if (d.evidenceRefs.length > 0) {
        for (const r of d.evidenceRefs) lines.push(`    evidence: source=${r.source} id=${r.id} :: ${r.label}${r.fileLine ? ` @${r.fileLine}` : ''}`);
    } else {
        lines.push('    evidence: (none — emit an honest gap card: choiceMade=null, evidenceRefs=[], followUps status="gap")');
    }
    for (const f of c.followUpQuestions) lines.push(`    follow-up: ${f}`);
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
    input: CoachAgentInput,
    ctx: StrategistPipelineContext,
): string {
    const { analysis } = input;
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
    if (input.evidenceBlock) {
        sections.push('## Verified Evidence (from Research)', input.evidenceBlock, '');
    }
    if (input.constraintBlock) {
        sections.push(input.constraintBlock, '');
    }
    if (input.skillCandidateBlock) {
        sections.push(input.skillCandidateBlock, '');
    }
    if (input.systemDesignBlock) {
        sections.push(input.systemDesignBlock, '');
    }
    if (input.barRaiserBlock) {
        sections.push(input.barRaiserBlock, '');
    }
    if (input.finalBlock) {
        sections.push('## Final-round prep context', input.finalBlock, '');
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

export const SYSTEM_DESIGN_FIELDS = ['systemDesignWalkthrough'] as const;

export const BAR_RAISER_FIELDS = ['barRaiserWalkthrough'] as const;

export const FINAL_FIELDS = ['finalPrep'] as const;

/** Stage → fields promoted to `required` for that stage's tool variant. */
const STAGE_REQUIRED_FIELDS: Record<string, readonly string[]> = {
    'phone-screen':  PHONE_SCREEN_FIELDS,
    'system-design': SYSTEM_DESIGN_FIELDS,
    'bar-raiser':    BAR_RAISER_FIELDS,
    'final':         FINAL_FIELDS,
};

/** Return the coach tool with stage-specific fields promoted to `required`. */
export function coachToolForStage(stage: string): typeof COACH_TOOL {
    const extra = STAGE_REQUIRED_FIELDS[stage];
    if (!extra) return COACH_TOOL;
    return {
        ...COACH_TOOL,
        inputSchema: { ...COACH_TOOL.inputSchema, required: [...COACH_TOOL.inputSchema.required, ...extra] },
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
        return buildCoachMessage(input, ctx);
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
        // Safety-net: the model occasionally wraps long free-text fields (e.g.
        // coachingNotes) in an XML `<![CDATA[ … ]]>` envelope echoed from the
        // prompt's tag structure. Strip it before validation/persistence so it
        // never reaches the UI as literal markup.
        const cleaned = deepStripCdata(raw);
        const validated = CoachOutputSchema.safeParse(cleaned);
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
 * Pre-serialised, stage-specific prompt blocks passed to {@link executeCoachAgent}.
 * Each is optional; only the blocks relevant to the current stage are populated.
 * Collapsed into one object (rather than positional params) to keep the
 * `executeCoachAgent` signature within the parameter-count budget as stages grow.
 */
export interface CoachBlocks {
    readonly constraintBlock?: string;
    readonly evidenceBlock?: string;
    readonly skillCandidateSets?: readonly SkillCandidateSet[];
    readonly systemDesignBlock?: string;
    readonly barRaiserBlock?: string;
    readonly finalBlock?: string;
}

/**
 * Execute the Interview Coach Agent.
 *
 * Backward-compatible wrapper that delegates to the
 * {@link CoachAgent} class instance.
 *
 * @param ctx - Pipeline context with interview stage
 * @param analysis - Strategist Agent's analysis output
 * @param blocks - Pre-serialised, stage-specific prompt blocks
 * @returns Interview coaching result with stage-specific preparation
 */
export async function executeCoachAgent(
    ctx: StrategistPipelineContext,
    analysis: StrategistAnalysisResult,
    blocks: CoachBlocks = {},
): Promise<AgentResult<InterviewCoachResult>> {
    const {
        constraintBlock, evidenceBlock, skillCandidateSets,
        systemDesignBlock, barRaiserBlock, finalBlock,
    } = blocks;
    const skillCandidateBlock = buildSkillCandidateBlock(skillCandidateSets ?? []);
    const result = await coachAgent.execute({ analysis, constraintBlock, evidenceBlock, skillCandidateBlock, systemDesignBlock, barRaiserBlock, finalBlock }, ctx);
    if (skillCandidateSets && skillCandidateSets.length > 0) {
        const raw = (result.data.skillTransfer ?? []) as SkillTransferEntry[];
        (result.data as { skillTransfer?: unknown }).skillTransfer = validateSkillTransfer(raw, skillCandidateSets);
    }
    return result;
}
