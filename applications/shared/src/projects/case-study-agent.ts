/**
 * @format
 * Project Case-Study Agent — Bedrock tool-use, Sonnet 4.6.
 *
 * One invocation per project. The model receives the full
 * `CaseStudyContext` (project + components + repos + commits + KB
 * chunks) and emits a single structured `CaseStudy` payload covering
 * every section: tagline, pitch, stack, decisions, highlights,
 * challenges, depth markers, architecture diagram, resume bullets per
 * angle.
 *
 * Why Sonnet rather than Haiku: case-study output is the headline
 * recruiter-facing surface and is read directly by humans. Clustering's
 * job (Haiku) is to pick groupings from signals; case-study's job is to
 * write convincing prose grounded in those repos. We mirror the
 * research(Haiku)+writer(Sonnet) split already used by the article
 * pipeline.
 *
 * Like clustering-agent, this module exposes a `ClusteringAgent`-style
 * interface so tests can inject a mock implementation without spinning
 * up Bedrock.
 */
import { runAgent, parseJsonResponse } from '../agent-runner.js';
import type { BasePipelineContext } from '../base-agent.js';
import type { AgentConfig, AgentResult } from '../types.js';

import {
    CaseStudySchema,
    PROJECT_TYPES,
    RESUME_BULLET_ANGLES,
    STACK_CATEGORIES,
    TEST_COVERAGE_SIGNALS,
    CI_MATURITY,
    DOC_DENSITY,
    type CaseStudy,
    type CaseStudyContext,
} from './case-study-types.js';
import { PROJECT_COMPONENT_KINDS } from './types.js';

// ─── Configuration ──────────────────────────────────────────────────────────

const CASE_STUDY_MODEL =
    process.env.CASE_STUDY_MODEL ??
    'eu.anthropic.claude-sonnet-4-6';

const EFFECTIVE_MODEL_ID =
    process.env.INFERENCE_PROFILE_ARN ?? CASE_STUDY_MODEL;

// Sonnet 4-6 supports up to 64k output tokens. The full case study (pitch +
// tagline + stack + decisions + highlights + challenges + depth markers +
// architecture + resume bullets across angles) is large structured JSON; 16k
// truncated multi_repo runs (stopReason='max_tokens' → thrown). 32k gives the
// generation room while staying well under both the output max and, combined
// with the 120k context budget, the overall context window.
const CASE_STUDY_MAX_TOKENS = 32_768;

/** Forced tool_use is incompatible with extended thinking. */
const CASE_STUDY_THINKING_BUDGET = 0;

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT_TEXT = `You are a portfolio editor writing the case study for a single project.
The project may span multiple repositories. Your output is read by
recruiters and engineers; treat every claim as something the author may
be asked about in an interview.

Lead with the PRODUCT, then the engineering. A recruiter must understand
what the thing IS, who it's for, and what problem it solves BEFORE any
stack or architecture detail. A pitch that opens with infrastructure
("a platform spanning four repositories running 14 microservices…") and
never says what the product does has failed, no matter how impressive the
internals.

Rules:
  1. Every decision / challenge / stack item MUST cite at least one
     concrete piece of evidence in \`sourceSignals.commits\`,
     \`sourceSignals.pulls\`, or \`sourceSignals.files\`. Pull requests
     are the strongest form of evidence — when one is available for a
     decision, prefer it over a commit. If you cannot cite evidence,
     do not include the row. Loose hand-waving is worse than omitting
     the section. A <fileChanges> block, when present, lists the
     most-changed files with their churn — cite those paths in
     \`sourceSignals.files\` to ground a challenge or highlight in WHAT
     changed, not just the commit message.
  2. PRODUCT CONTEXT: when a <productContext> block is supplied, it is
     GROUND TRUTH about what the product is, who it serves, and the
     problem it solves. Treat it as authoritative — it is a given, NOT a
     claim, so it is EXEMPT from the evidence-citation rule above. Use it
     to frame the tagline and the FIRST paragraph of the pitch. Never
     contradict it or invent product purpose beyond it. If no
     <productContext> is supplied, infer the product's purpose from the
     repositories/components and README-style KB passages — still lead
     with what it does, not how it's built.
  3. The \`tagline\` is a single sentence under 200 characters that says
     what the product is and who it's for (not a tech-stack summary).
     The \`pitch\` is at most three short paragraphs: paragraph 1 = what
     it does + who it's for + the problem it solves (from productContext);
     paragraphs 2–3 = the engineering approach and depth. Written in the
     candidate's voice ("I built" / "I designed", never "we built").
  4. \`decisions\` are ADR-style: title, context (problem), decision
     (what was chosen), consequences (tradeoff). At most 5.
  5. \`challenges\` answer "tell me about a hard problem you solved" —
     each is a problem / solution pair grounded in real commits or
     issues. At most 5.
  6. \`highlights\` are 3–5 things a recruiter could point to in 5
     seconds: shipped features, scale numbers, public outcomes.
  7. \`resumeBullets\`: one set per relevant angle. Bullets are
     past-tense, quantified where possible, never longer than 250
     characters. Omit angles that don't apply to this project.
  8. \`depthMarkers\` is an HONEST assessment of engineering maturity.
     "comprehensive" documentation means a docs/ folder with multiple
     files plus a thorough README — do not inflate.
  9. \`architecture\` is a Mermaid graph (graph LR or graph TD).
     Rectangles for services, cylinders for datastores, clouds for
     external services. Keep it readable in 5 seconds.

The input is a compact JSON envelope describing the project, its
components, its repositories, recent commits, and selected KB passages,
plus an optional <productContext> block. Use <productContext> for the
product framing (tagline + first pitch paragraph) and commits + KB
passages as evidence for every grounded engineering claim.`;

/**
 * Build the system prompt, appending an archetype/stage calibration block
 * when the context carries a classified archetype. Soft guidance only — it
 * shifts section emphasis; it never changes the output schema, the evidence
 * requirement, or the grounding pass. Absent archetype → base prompt verbatim.
 */
// Appended when a prior case study is supplied — turns the run into an
// incremental refine rather than a from-scratch write.
const REFINE_PROMPT_BLOCK = `
REFINE MODE — a prior case study for this project is supplied in <priorCaseStudy>.
The project has changed since it was written (typically a repository was added).
Produce the UPDATED full case study, not a fresh one:
  - PRESERVE prior decisions / challenges / highlights / stack that are still
    accurate. Reuse their \`sourceSignals\` verbatim — those rows are already
    grounded; you do not need new evidence to keep them.
  - ADD rows for work shown by the newly-supplied commits / pulls / KB that the
    prior case study missed. Ground every new row in that evidence.
  - DROP a prior row only if it is now wrong or superseded.
  - REVISE the tagline, pitch, architecture, and resume bullets so they describe
    the project AS IT NOW STANDS across all repositories and components.
  - Do NOT duplicate a prior item with reworded text. Respect the same caps
    (≤5 decisions, ≤5 highlights, ≤5 challenges).
  - COVERAGE: any repository listed in <newRepos> is newly added and absent from
    the prior case study. Each one MUST appear in at least one highlight AND one
    challenge, grounded in its commits/pulls/files — drop or merge a weaker prior
    item to make room within the caps if needed. A new repo that only shows up in
    the stack list is NOT sufficient.`;

export function buildSystemPrompt(context: CaseStudyContext): string {
    let prompt = SYSTEM_PROMPT_TEXT;
    if (context.archetype) {
        const stageLabel = context.stage ?? 'unspecified';
        const priority   = (context.prioritySections ?? []).join(', ');
        const deemph     = (context.deemphasizedSections ?? []).join(', ');
        const block = [
            '',
            'Project calibration:',
            `This is a ${stageLabel}-level ${context.archetype.name} project.` +
                (priority ? ` Recruiters at this level look hardest at: ${priority}. Prioritise depth and evidence in those sections.` : ''),
            deemph ? `De-emphasise: ${deemph}.` : '',
            'Still emit every section the evidence supports — calibration changes emphasis, never truthfulness. Omit any section you cannot ground.',
        ].filter(Boolean).join('\n');
        prompt = `${prompt}\n${block}`;
    }
    if (context.priorCaseStudy) prompt = `${prompt}\n${REFINE_PROMPT_BLOCK}`;
    return prompt;
}

// ─── Forced tool_use schema ─────────────────────────────────────────────────

const SOURCE_SIGNAL_SCHEMA = {
    type: 'object',
    properties: {
        commits: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    repoFullName: { type: 'string' },
                    sha:          { type: 'string', pattern: '^[0-9a-f]{7,40}$' },
                    authoredAt:   { type: 'string' },
                    message:      { type: 'string' },
                },
                required: ['repoFullName', 'sha', 'authoredAt', 'message'],
                additionalProperties: false,
            },
        },
        pulls: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    repoFullName: { type: 'string' },
                    number:       { type: 'integer', minimum: 1 },
                    title:        { type: 'string' },
                    htmlUrl:      { type: 'string', format: 'uri' },
                    mergedAt:     { type: ['string', 'null'] },
                },
                required: ['repoFullName', 'number', 'title', 'htmlUrl', 'mergedAt'],
                additionalProperties: false,
            },
        },
        files: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    repoFullName: { type: 'string' },
                    path:         { type: 'string' },
                    chunkId:      { type: 'string', format: 'uuid' },
                },
                required: ['repoFullName', 'path'],
                additionalProperties: false,
            },
        },
        ungroundedClaims: { type: 'array', items: { type: 'string' } },
        grounding:        { type: 'string', enum: ['GROUNDED', 'NOT_GROUNDED', 'NOT_VERIFIED'] },
    },
    required: ['commits', 'pulls', 'files', 'ungroundedClaims', 'grounding'],
    additionalProperties: false,
};

const STACK_ITEM_SCHEMA = {
    type: 'object',
    properties: {
        category:      { type: 'string', enum: [...STACK_CATEGORIES] },
        name:          { type: 'string', minLength: 1, maxLength: 80 },
        justification: { type: 'string', maxLength: 2000 },
        componentName: { type: 'string', maxLength: 80 },
        sourceSignals: SOURCE_SIGNAL_SCHEMA,
    },
    required: ['category', 'name', 'justification', 'sourceSignals'],
    additionalProperties: false,
};

const DECISION_SCHEMA = {
    type: 'object',
    properties: {
        title:         { type: 'string', minLength: 1, maxLength: 200 },
        context:       { type: 'string', maxLength: 2000 },
        decision:      { type: 'string', maxLength: 2000 },
        consequences:  { type: 'string', maxLength: 2000 },
        confidence:    { type: 'string', enum: ['high', 'medium', 'low'] },
        sourceSignals: SOURCE_SIGNAL_SCHEMA,
    },
    required: ['title', 'context', 'decision', 'consequences', 'confidence', 'sourceSignals'],
    additionalProperties: false,
};

const HIGHLIGHT_SCHEMA = {
    type: 'object',
    properties: {
        title:         { type: 'string', minLength: 1, maxLength: 200 },
        description:   { type: 'string', minLength: 1, maxLength: 2000 },
        sourceSignals: SOURCE_SIGNAL_SCHEMA,
    },
    required: ['title', 'description', 'sourceSignals'],
    additionalProperties: false,
};

const CHALLENGE_SCHEMA = {
    type: 'object',
    properties: {
        problem:       { type: 'string', minLength: 1, maxLength: 2000 },
        solution:      { type: 'string', minLength: 1, maxLength: 2000 },
        sourceSignals: SOURCE_SIGNAL_SCHEMA,
    },
    required: ['problem', 'solution', 'sourceSignals'],
    additionalProperties: false,
};

const RESUME_BULLET_SET_SCHEMA = {
    type: 'object',
    properties: {
        angle:   { type: 'string', enum: [...RESUME_BULLET_ANGLES] },
        bullets: {
            type: 'array',
            minItems: 1, maxItems: 8,
            items: { type: 'string', minLength: 1, maxLength: 500 },
        },
    },
    required: ['angle', 'bullets'],
    additionalProperties: false,
};

const DEPTH_MARKERS_SCHEMA = {
    type: 'object',
    properties: {
        hasTests:              { type: 'boolean' },
        testCoverageSignal:    { type: 'string', enum: [...TEST_COVERAGE_SIGNALS] },
        hasCi:                 { type: 'boolean' },
        ciMaturity:            { type: 'string', enum: [...CI_MATURITY] },
        documentationDensity:  { type: 'string', enum: [...DOC_DENSITY] },
        hasDeploymentEvidence: { type: 'boolean' },
        deploymentUrl:         { type: ['string', 'null'] },
        refactorCount:         { type: 'integer', minimum: 0 },
    },
    required: [
        'hasTests', 'testCoverageSignal', 'hasCi', 'ciMaturity',
        'documentationDensity', 'hasDeploymentEvidence', 'refactorCount',
    ],
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

const CASE_STUDY_TOOL = {
    name: 'emit_case_study',
    description: 'Emit the full case study for a single project.',
    inputSchema: {
        type: 'object',
        properties: {
            tagline:       { type: 'string', minLength: 1, maxLength: 200 },
            pitch:         { type: 'string', minLength: 1, maxLength: 4000 },
            stack:         { type: 'array', maxItems: 40, items: STACK_ITEM_SCHEMA },
            decisions:     { type: 'array', maxItems: 5,  items: DECISION_SCHEMA },
            highlights:    { type: 'array', maxItems: 5,  items: HIGHLIGHT_SCHEMA },
            challenges:    { type: 'array', maxItems: 5,  items: CHALLENGE_SCHEMA },
            depthMarkers:  DEPTH_MARKERS_SCHEMA,
            architecture: ARCHITECTURE_SCHEMA,
            resumeBullets: {
                type: 'array',
                minItems: 1, maxItems: RESUME_BULLET_ANGLES.length,
                items: RESUME_BULLET_SET_SCHEMA,
            },
        },
        required: [
            'tagline', 'pitch', 'stack', 'decisions', 'highlights',
            'challenges', 'depthMarkers', 'architecture', 'resumeBullets',
        ],
        additionalProperties: false,
    },
};

// ─── User message ───────────────────────────────────────────────────────────

export function buildUserMessage(ctx: CaseStudyContext): string {
    // Trim to the project envelope the model needs. We deliberately do not
    // forward `user_overrides` here — sticky-edit enforcement lives at the
    // persistence layer.
    const envelope = {
        projectName:  ctx.projectName,
        tagline:      ctx.tagline,
        pitch:        ctx.pitch,
        components:   ctx.components,
        repositories: ctx.repositories,
        commits:      ctx.commits,
        pulls:        ctx.pulls,
    };
    const lines = [
        '<project>',
        JSON.stringify(envelope),
        '</project>',
    ];
    if (ctx.productContext && ctx.productContext.trim().length > 0) {
        lines.push(
            '<productContext>',
            ctx.productContext,
            '</productContext>',
        );
    }
    lines.push(
        '<kbChunks>',
        JSON.stringify(ctx.kbChunks),
        '</kbChunks>',
    );
    // Real file-level change evidence (from ingested commit diffs). The agent may
    // cite these paths in sourceSignals.files to ground challenges/highlights in
    // WHAT changed, not just commit messages.
    if (ctx.fileChangeEvidence && ctx.fileChangeEvidence.length > 0) {
        lines.push(
            '<fileChanges>',
            JSON.stringify(ctx.fileChangeEvidence),
            '</fileChanges>',
        );
    }
    if (ctx.priorCaseStudy) {
        lines.push(
            '<priorCaseStudy>',
            JSON.stringify(ctx.priorCaseStudy),
            '</priorCaseStudy>',
        );
        if (ctx.refineNewRepos && ctx.refineNewRepos.length > 0) {
            lines.push(
                '<newRepos>',
                JSON.stringify(ctx.refineNewRepos),
                '</newRepos>',
            );
        }
    }
    lines.push('', `Emit the ${CASE_STUDY_TOOL.name} tool now.`);
    return lines.join('\n');
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

export interface CaseStudyAgent {
    invoke(
        context: CaseStudyContext,
        ctx:     BasePipelineContext,
    ): Promise<AgentResult<CaseStudy>>;
}

export const bedrockCaseStudyAgent: CaseStudyAgent = {
    async invoke(context, ctx) {
        const config: AgentConfig = {
            agentName:      'project-case-study',
            modelId:        EFFECTIVE_MODEL_ID,
            maxTokens:      CASE_STUDY_MAX_TOKENS,
            thinkingBudget: CASE_STUDY_THINKING_BUDGET,
            systemPrompt:   [{ text: buildSystemPrompt(context) }],
            pipeline:       'project-case-study',
            promptId:       'project-case-study-v1',
            tool:           CASE_STUDY_TOOL,
        };

        // Silence unused — kept for explicit documentation that this set
        // is the allowable project types.
        void PROJECT_TYPES;

        return runAgent<CaseStudy>({
            config,
            userMessage:    buildUserMessage(context),
            pipelineContext: ctx,
            parseResponse: (text) => {
                const raw = parseJsonResponse<unknown>(text, 'project-case-study');
                const parsed = CaseStudySchema.safeParse(raw);
                if (!parsed.success) {
                    throw new Error(
                        `case-study output failed schema: ${parsed.error.message}`,
                    );
                }
                return parsed.data;
            },
        });
    },
};
