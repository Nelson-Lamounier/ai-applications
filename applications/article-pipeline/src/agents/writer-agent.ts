/**
 * @format
 * Writer Agent — Full MDX Article Generation
 *
 * Second agent in the lean 3-agent pipeline. Takes the structured
 * research brief from the Research Agent and generates a complete
 * MDX article with frontmatter, components, and visual directives.
 *
 * Uses Sonnet 4.6 for creative writing — the Writer task requires
 * top-tier reasoning, narrative voice, and technical accuracy.
 *
 * Pipeline position: Research → **Writer** → QA → Review
 */

import { z } from 'zod';
import type { SystemContentBlock } from '@aws-sdk/client-bedrock-runtime';
import { BaseAgent, parseJsonResponse, log } from '@bedrock/shared';
import { BLOG_PERSONA_SYSTEM_PROMPT } from '../prompts/blog-persona.js';
import { WRITER_CORE_BLOCKS } from '../prompts/writer-core-prompt.js';
import { selectArchetype } from '../prompts/archetypes.js';
import { assembleDynamicBlock, type ResearchBrief } from '../prompts/prompt-assembler.js';
import type {
    AgentConfig,
    AgentResult,
    ArticleMetadata,
    PipelineContext,
    ResearchResult,
    ShotListItem,
    SuggestedReference,
    WriterResult,
} from '@bedrock/shared';

// =============================================================================
// INPUT TYPE
// =============================================================================

/**
 * Typed input for the Writer Agent.
 *
 * Contains the Research Agent's output which provides the
 * structured brief, complexity classification, and KB context.
 */
export interface WriterAgentInput {
    /** Research Agent's structured output */
    readonly research: ResearchResult;
    /**
     * QA feedback from a prior failed attempt, injected on retry so the Writer
     * fixes the specific issues rather than regenerating blind. Empty on the
     * first attempt.
     */
    readonly revisionNotes?: readonly string[];
}

// =============================================================================
// CONFIGURATION
// =============================================================================

/**
 * Writer Agent model — uses Sonnet 4.6 for creative generation.
 * Falls back to cross-region Sonnet profile if not set.
 */
const WRITER_MODEL = process.env.FOUNDATION_MODEL ?? 'eu.anthropic.claude-sonnet-4-6';

/**
 * Application Inference Profile ARN — enables granular FinOps cost attribution.
 * When set, used as the model ID for Bedrock invocation instead of the raw model ID.
 */
const EFFECTIVE_MODEL_ID = process.env.INFERENCE_PROFILE_ARN ?? WRITER_MODEL;

/** Maximum output tokens for Writer Agent response (full MDX articles need substantial headroom) */
const WRITER_MAX_TOKENS = Number.parseInt(process.env.MAX_TOKENS ?? '65536', 10);

/** Default thinking budget (overridden by Research Agent complexity tier) */
const DEFAULT_THINKING_BUDGET = Number.parseInt(process.env.THINKING_BUDGET_TOKENS ?? '16000', 10);

// =============================================================================
// SYSTEM PROMPT ASSEMBLY (evidence-driven archetype, flag-gated)
// =============================================================================

/** Dark-launch flag for evidence-driven archetype assembly. */
function archetypeAssemblyEnabled(): boolean {
    return process.env['ARTICLE_ARCHETYPE_ASSEMBLY'] === '1';
}

/** Map the research result's brief fields into the assembler's ResearchBrief. */
function briefFromResearch(research: ResearchResult): ResearchBrief | null {
    const inv = research.evidenceInventory;
    if (!inv) return null;
    return {
        slug:               '',
        topic:              research.suggestedTitle,
        evidenceInventory:  inv,
        citableLinks:       (research.citableLinks ?? []).map((l) => ({ url: l.url, supportsClaim: l.supportsClaim })),
        publicRepos:        [...(research.publicRepos ?? [])],
        publishIdentifiers: [...(research.publishIdentifiers ?? [])],
        availableMetrics:   (research.availableMetrics ?? []).map((m) => ({ value: m.value, measures: m.measures })),
    };
}

/**
 * Choose the Writer system prompt. When the archetype flag is on and the
 * research carries an evidence inventory, assemble the universal core (cached)
 * + the selected archetype + brief (uncached). Falls back to the static blog
 * persona when the flag is off, the inventory is absent, or — defensively —
 * the evidence is ineligible (run-pipeline gates ineligibility before this).
 */
export function buildWriterSystemPrompt(research: ResearchResult): SystemContentBlock[] {
    if (!archetypeAssemblyEnabled()) return BLOG_PERSONA_SYSTEM_PROMPT;
    const brief = briefFromResearch(research);
    if (!brief) return BLOG_PERSONA_SYSTEM_PROMPT;
    const selection = selectArchetype(brief.evidenceInventory);
    if (!selection.eligible) return BLOG_PERSONA_SYSTEM_PROMPT;
    return [
        ...WRITER_CORE_BLOCKS,
        { cachePoint: { type: 'default' } } as SystemContentBlock,
        { text: assembleDynamicBlock(selection, brief) },
    ];
}

// =============================================================================
// USER MESSAGE BUILDER
// =============================================================================

/**
 * Build the user message for the Writer Agent.
 *
 * Provides the Writer with the Research Agent's structured brief,
 * including KB context, complexity classification, and proposed outline.
 *
 * @param research - Research result from the Research Agent
 * @param retryAttempt - Current retry attempt (0-based)
 * @returns Formatted user message
 */
/** Retry banner + the concrete QA issues to fix, injected on a retry attempt. */
function buildRetryNote(retryAttempt: number, revisionNotes: readonly string[]): string[] {
    if (retryAttempt === 0) return [];
    const feedback = revisionNotes.length > 0
        ? [
              `>`,
              `> ## QA Feedback To Fix (from the previous attempt)`,
              `> Resolve each of these specific issues. Do not reintroduce them.`,
              ...revisionNotes.map((note) => `> - ${note}`),
          ]
        : [];
    return [
        ``,
        `> ⚠️ This is retry attempt ${retryAttempt}. The previous version did not pass QA.`,
        `> Pay extra attention to technical accuracy and code correctness.`,
        ...feedback,
    ];
}

function buildContextSection(
    research: ResearchResult,
    retryAttempt: number,
    version: number,
    revisionNotes: readonly string[] = [],
): string[] {
    return [
        ...buildRetryNote(retryAttempt, revisionNotes),
        ...(research.authorDirection
            ? [
                  ``,
                  `## ⚡ Author's Direction`,
                  `> This is the author's specific creative direction for this article.`,
                  `> Your article MUST directly address these instructions.`,
                  `> Do NOT let KB context or standard templates override this direction.`,
                  ``,
                  research.authorDirection
              ]
            : []),
        ...((research.verifiedMetrics?.length ?? 0) > 0
            ? [
                  ``,
                  `## ✅ Verified Metrics (authoritative — you MAY cite these)`,
                  `> These are real, author-confirmed measured numbers for this work.`,
                  `> They are an AUTHORITATIVE source: cite them directly in the Challenge`,
                  `> Log and the Value Bridge to give the article a concrete result. Do NOT`,
                  `> alter the values, and do NOT invent additional numbers beyond these.`,
                  ``,
                  ...(research.verifiedMetrics ?? []).map((m) => {
                      const unit = m.unit ? ` ${m.unit}` : '';
                      const src = m.source ? ` (source: ${m.source})` : '';
                      return `- ${m.label}: ${m.value}${unit}${src}`;
                  }),
              ]
            : []),
        ...(research.previousVersionContent
            ? [
                  ``,
                  `## 🔄 Previous Version (v${version - 1})`,
                  `> A previous version of this article already exists. The author has submitted`,
                  `> a NEW prompt with DIFFERENT creative direction (see "Author's Direction" above).`,
                  `> You MUST generate a substantially different article that addresses the new direction.`,
                  `> Do NOT simply rephrase, extend, or lightly edit the previous version.`,
                  ``,
                  `--- BEGIN PREVIOUS VERSION ---`,
                  research.previousVersionContent,
                  `--- END PREVIOUS VERSION ---`
              ]
            : []),
        ...(research.kbPassages.length > 0
            ? [
                  ``,
                  `## Knowledge Base Context`,
                  `The following passages are from the project's real infrastructure documentation:`,
                  ``,
                  ...research.kbPassages.flatMap((passage, i) => [
                      `### KB Passage ${i + 1} (relevance: ${passage.score.toFixed(3)})`,
                      passage.text,
                      ``
                  ])
              ]
            : [])
    ];
}

function buildOutlineAndFactsSection(research: ResearchResult): string[] {
    return [
        ...(research.outline.length > 0
            ? [
                  ``,
                  `## Proposed Article Outline`,
                  `The Research Agent suggests the following structure:`,
                  ``,
                  ...research.outline.flatMap(section => {
                      const visualMarker = section.needsVisual ? ' 📊' : '';
                      const heading = `- **${section.heading}** (~${section.wordBudget} words)${visualMarker}`;
                      return section.keyPoints.length > 0
                          ? [heading, ...section.keyPoints.map(point => `  - ${point}`)]
                          : [heading];
                  })
              ]
            : []),
        ...(research.technicalFacts.length > 0
            ? [
                  ``,
                  `## Verified Technical Facts`,
                  `These facts were extracted from the draft and KB. Preserve them accurately:`,
                  ``,
                  ...research.technicalFacts.map(fact => `- ${fact}`)
              ]
            : [])
    ];
}

function buildSeoSection(research: ResearchResult): string[] {
    if (!research.seoResearch) {
        return [];
    }

    return [
        ``,
        `## SEO Research Brief`,
        `- Primary Keyword: ${research.seoResearch.primaryKeyword}`,
        ...(research.seoResearch.secondaryKeywords.length > 0
            ? [`- Secondary Keywords: ${research.seoResearch.secondaryKeywords.join(', ')}`]
            : []),
        ...(research.seoResearch.suggestedReferences.length > 0
            ? [
                  ``,
                  `### Suggested Authoritative References`,
                  `The Research Agent identified these external links for credibility:`,
                  ...research.seoResearch.suggestedReferences.flatMap(ref =>
                      ref.relevance
                          ? [`- **${ref.label}**: [${ref.url}](${ref.url})`, `  *Relevance: ${ref.relevance}*`]
                          : [`- **${ref.label}**: [${ref.url}](${ref.url})`]
                  )
              ]
            : [])
    ];
}

function buildWriterMessage(
    research: ResearchResult,
    retryAttempt: number,
    version: number,
    revisionNotes: readonly string[] = [],
): string {
    const parts: string[] = [
        `## Content Generation Request`,
        `- Pipeline Mode: ${research.mode}`,
        `- Complexity: ${research.complexity.tier} — ${research.complexity.reason}`,
        `- Suggested Title: ${research.suggestedTitle}`,
        `- Suggested Tags: ${research.suggestedTags.join(', ')}`,
        ...buildContextSection(research, retryAttempt, version, revisionNotes),
        ...buildOutlineAndFactsSection(research),
        ...buildSeoSection(research),
        ``,
        `## Source Draft`,
        `--- BEGIN DRAFT ---`,
        research.draftContent,
        `--- END DRAFT ---`,
        ``,
        `Generate the complete MDX article. Return the JSON output as specified in your system prompt.`
    ];

    return parts.join('\n');
}

// =============================================================================
// RESPONSE PARSER
// =============================================================================

/**
 * Parse the Writer Agent's JSON response into a typed WriterResult.
 *
 * @param responseText - Raw text response from Bedrock
 * @returns Validated WriterResult
 * @throws Error if required fields are missing
 */
/**
 * Safety-net for the Writer's structured JSON. Writer keeps extended
 * thinking so forced tool_use is unavailable; this Zod schema is the
 * constrained-decoding substitute — it enforces every required field and
 * its type, and `content` (prose) stays a free-form non-empty string.
 *
 * These objects STRIP unknown keys rather than `.strict()`-rejecting them.
 * Rejecting was too brittle: the model, cued by the frontmatter example
 * (`author: "Nelson Lamounier"`), intermittently echoes an extra `author`
 * key into `metadata`, and `.strict()` then threw away the ENTIRE,
 * already-paid-for generation (~$0.25 of Bedrock spend — research + writer,
 * billed before this local check runs, with no retry). Stripping keeps the
 * real fields and silently drops stray ones, so a harmless extra key never
 * discards an expensive run. Required-field and type validation is unchanged.
 */
const WriterMetadataSchema = z.object({
    title:               z.string().min(1),
    description:         z.string(),
    tags:                z.array(z.string()),
    slug:                z.string().min(1),
    publishDate:         z.string(),
    readingTime:         z.number(),
    category:            z.string(),
    aiSummary:           z.string(),
    technicalConfidence: z.number(),
    skillsDemonstrated:  z.array(z.string()),
    processingNote:      z.string(),
    primaryKeyword:      z.string().optional(),
    secondaryKeywords:   z.array(z.string()).optional(),
});

const ShotListItemSchema = z.object({
    id:          z.string(),
    type:        z.enum(['diagram', 'screenshot', 'hero', 'tutorial', 'demo', 'walkthrough']),
    instruction: z.string(),
    context:     z.string(),
    duration:    z.string().optional(),
});

const SuggestedReferenceSchema = z.object({
    label:      z.string(),
    url:        z.string(),
    relevance:  z.string(),
    usedInline: z.boolean(),
});

const WriterOutputSchema = z.object({
    content:             z.string().min(1, 'Writer Agent: missing or empty "content"'),
    metadata:            WriterMetadataSchema,
    shotList:            z.array(ShotListItemSchema).default([]),
    suggestedReferences: z.array(SuggestedReferenceSchema).optional(),
});

/**
 * Parse and validate the Writer Agent's JSON response.
 *
 * @param responseText - Raw text response from Bedrock
 * @returns Validated WriterResult
 * @throws Error if the output is missing content or fails schema validation
 */
export function parseWriterResponse(responseText: string): WriterResult {
    const raw = parseJsonResponse<unknown>(responseText, 'writer');
    const v = WriterOutputSchema.safeParse(raw);
    if (!v.success) {
        // Surface the empty-content guard message verbatim when that is
        // the cause; otherwise a generic schema-validation failure.
        const msg = v.error.issues.find(i => i.path[0] === 'content')?.message
            ?? `Writer Agent: output failed schema validation: ${v.error.message}`;
        throw new TypeError(msg);
    }
    const d = v.data;
    return {
        content: d.content,
        metadata: {
            ...d.metadata,
            technicalConfidence: Math.max(0, Math.min(100, d.metadata.technicalConfidence)),
        } as ArticleMetadata,
        shotList: d.shotList as ShotListItem[],
        suggestedReferences: d.suggestedReferences && d.suggestedReferences.length > 0
            ? (d.suggestedReferences as SuggestedReference[])
            : undefined,
    };
}

// =============================================================================
// WRITER AGENT CLASS
// =============================================================================

/**
 * Writer Agent — MDX article generation via Bedrock Converse API.
 *
 * Extends {@link BaseAgent} to encapsulate the Writer's lifecycle:
 * - Dynamic thinking budget based on Research Agent's complexity tier
 * - Full MDX article generation with frontmatter and visual directives
 * - Structured metadata and shot list extraction
 *
 * @example
 * ```typescript
 * const result = await writerAgent.execute({ research }, ctx);
 * ```
 */
class WriterAgent extends BaseAgent<WriterAgentInput, WriterResult, PipelineContext> {
    protected readonly agentName = 'writer' as const;

    /**
     * Build writer configuration with dynamic thinking budget.
     *
     * The thinking budget is capped at {@link DEFAULT_THINKING_BUDGET}
     * but scaled down for simpler content based on the Research Agent's
     * complexity classification.
     *
     * @param input - Writer input with research complexity tier
     * @returns Agent config with adaptive thinking budget
     */
    protected getConfig(input: WriterAgentInput): AgentConfig {
        const thinkingBudget = Math.min(
            input.research.complexity.budgetTokens,
            DEFAULT_THINKING_BUDGET,
        );

        return {
            agentName: 'writer',
            modelId: EFFECTIVE_MODEL_ID,
            maxTokens: WRITER_MAX_TOKENS,
            thinkingBudget,
            systemPrompt: buildWriterSystemPrompt(input.research),
        };
    }

    /**
     * Build the user message from the research brief.
     *
     * @param input - Writer input with research result
     * @param ctx   - Pipeline context for retry/version info
     * @returns Formatted user message for Bedrock
     */
    protected buildUserMessage(input: WriterAgentInput, ctx: PipelineContext): string {
        return buildWriterMessage(input.research, ctx.retryAttempt, ctx.version, input.revisionNotes);
    }

    /**
     * Parse the raw LLM text into a typed WriterResult.
     *
     * @param responseText - Raw text response from Bedrock
     * @returns Validated WriterResult
     */
    protected parseResponse(responseText: string): WriterResult {
        return parseWriterResponse(responseText);
    }

    /**
     * Pre-execution hook — logs complexity and retry context.
     *
     * @param input - Writer input
     * @param ctx   - Pipeline context
     */
    protected override beforeExecute(input: WriterAgentInput, ctx: PipelineContext): void {
        const thinkingBudget = Math.min(
            input.research.complexity.budgetTokens,
            DEFAULT_THINKING_BUDGET,
        );

        log('INFO', 'Generating article', {
            agent: 'writer',
            complexity: input.research.complexity.tier,
            thinkingBudget,
            retryAttempt: ctx.retryAttempt,
        });
    }

    /**
     * Post-execution hook — logs article metadata.
     *
     * @param result - Writer agent result
     */
    protected override afterExecute(result: AgentResult<WriterResult>): void {
        log('INFO', 'Article generated', {
            agent: 'writer',
            title: result.data.metadata.title,
            slug: result.data.metadata.slug,
            readingTime: result.data.metadata.readingTime,
            confidence: result.data.metadata.technicalConfidence,
            shotListCount: result.data.shotList.length,
        });
    }
}

/** Module-level singleton — re-used across Lambda invocations. */
const writerAgent = new WriterAgent();

/** Export the agent instance for direct usage. */
export { writerAgent, WriterAgent };

/**
 * Execute the Writer Agent.
 *
 * Backward-compatible wrapper that delegates to the
 * {@link WriterAgent} class instance. Handlers can use this
 * without any import path changes.
 *
 * @param ctx - Pipeline context
 * @param research - Research result from the first agent
 * @param revisionNotes - QA feedback from a prior failed attempt (retry only)
 * @returns Writer result with MDX content, metadata, and shot list
 */
export async function executeWriterAgent(
    ctx: PipelineContext,
    research: ResearchResult,
    revisionNotes?: readonly string[],
): Promise<AgentResult<WriterResult>> {
    return writerAgent.execute({ research, revisionNotes }, ctx);
}
