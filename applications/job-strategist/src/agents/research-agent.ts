/**
 * @format
 * Strategist Research Agent — RDS Vector Retrieval, Resume Parsing & Gap Analysis
 *
 * First agent in the 3-agent strategist pipeline. Receives the raw
 * job description, queries the RDS pgvector Knowledge Base for portfolio
 * and project data, reads the resume from pipeline context (fetched at
 * pipeline start), and produces a structured research brief with
 * verified/partial/gap skill classification.
 *
 * Uses Haiku 4.5 for cost-efficient extraction and analysis.
 *
 * Pipeline position: Trigger → **Research** → Strategist → Coach → RDS persist
 */

import {
    runAgent,
    parseJsonResponse,
    InputSanitiser,
    PiiScrubber,
    BedrockReranker,
    RdsVectorStore,
    TitanEmbeddingProvider,
    log,
} from '@bedrock/shared';
import type {
    AgentConfig,
    AgentResult,
    IReranker,
    PiiPattern,
    RerankCandidate,
    StructuredResumeData,
    StrategistPipelineContext,
    StrategistResearchResult,
} from '@bedrock/shared';
import { formatResumeForPrompt } from '../services/resume-service.js';
import { RESEARCH_PERSONA_SYSTEM_PROMPT } from '../prompts/research-persona.js';
import { RESUME_CONSTRAINTS } from '../prompts/resume-constraints.js';

/** Delimiter used to join and later split deduplicated KB passages. */
export const KB_CONTEXT_SEPARATOR = '\n\n---\n\n';

/**
 * PII patterns specific to job description inputs.
 * Flags (warns) without redacting — JDs may legitimately contain recruiter contact info.
 */
const STRATEGIST_PII_PATTERNS: ReadonlyArray<PiiPattern> = [
    { regex: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, label: 'phone-number' },
    { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, label: 'email-address' },
    { regex: /\b\d{3}-\d{2}-\d{4}\b/g, label: 'ssn-like-pattern' },
];

/** Module-scoped sanitiser with strategist-specific length and PII config */
const inputSanitiser = new InputSanitiser({
    minLength: 50,
    maxLength: 50_000,
    piiPatterns: STRATEGIST_PII_PATTERNS,
});

/** Module-scoped PII scrubber — always-on redaction before retrieval, Bedrock, and logs */
const piiScrubber = new PiiScrubber();

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Research Agent model — set by CDK via RESEARCH_MODEL environment variable */
const RESEARCH_MODEL = process.env.RESEARCH_MODEL;
if (!RESEARCH_MODEL) {
    throw new Error(
        'Missing required environment variable RESEARCH_MODEL. ' +
        'This must be set by CDK infrastructure (e.g. eu.anthropic.claude-haiku-4-5-20251001-v1:0)',
    );
}

/**
 * Application Inference Profile ARN — enables granular FinOps cost attribution.
 * When set, used as the model ID for Bedrock invocation instead of the raw model ID.
 */
const EFFECTIVE_MODEL_ID = process.env.INFERENCE_PROFILE_ARN ?? RESEARCH_MODEL;

/** Maximum output tokens — must exceed thinkingBudget + expected JSON output.
 *  thinkingBudget=4096 + research JSON brief ~8-12K tokens = 16384 minimum. */
const RESEARCH_MAX_TOKENS = 16000;

/** Thinking budget for analysis tasks */
const RESEARCH_THINKING_BUDGET = 4096;

/** Max pgvector passages surfaced to the LLM after optional reranking. */
const MAX_KB_PASSAGES = 15;

/**
 * Over-fetch factor — retrieve this × MAX_KB_PASSAGES candidates so the
 * cross-encoder reranker has a richer pool. 15 × 4 = 60, under the 100-doc
 * Bedrock Rerank API cap.
 */
const RETRIEVE_OVERFETCH = 4;

const RERANKER_DISABLED = process.env.RERANKER_DISABLED === '1';

// =============================================================================
// CLIENTS
// =============================================================================

const embedder = TitanEmbeddingProvider.fromEnvironment();

const reranker: IReranker | null = RERANKER_DISABLED
    ? null
    : BedrockReranker.fromEnvironment();

// =============================================================================
// RDS VECTOR RETRIEVAL
// =============================================================================

/**
 * Execute a single RDS pgvector retrieval query scoped to a specific user.
 *
 * Retrieval flow:
 *   1. Embed the query text via Titan Embed Text v2 (1024-dim).
 *   2. Over-fetch RETRIEVE_OVERFETCH × MAX_KB_PASSAGES candidates via HNSW.
 *   3. Rerank with Bedrock cross-encoder; fall back to cosine-only on failure.
 *   4. Return the top MAX_KB_PASSAGES as annotated passage strings.
 *
 * @param query  - Search query text
 * @param userId - Authenticated user ID — RdsVectorStore WHERE-filters to this user
 * @param store  - RdsVectorStore instance backed by the pipeline PG pool
 * @returns Annotated passage strings ready for LLM context injection
 */
async function querySingleRds(query: string, userId: string, store: RdsVectorStore): Promise<string[]> {
    const overfetch = MAX_KB_PASSAGES * RETRIEVE_OVERFETCH;

    log('INFO', 'Querying RDS vector store', {
        agent:        'strategist-research',
        queryPreview: piiScrubber.scrub(query.substring(0, 80)).redacted,
        retrieveK:    overfetch,
        finalK:       MAX_KB_PASSAGES,
        rerank:       reranker !== null,
    });

    const queryEmbedding = await embedder.embed(query);
    const results = await store.querySimilar({
        userId,
        queryEmbedding,
        queryText:  query,
        useHybrid:  true,
        limit:      overfetch,
    });

    const passages = results.map((r, i) => ({
        id:          String(i),
        source:      `${r.repoFullName}/${r.filePath}`,
        cosineScore: r.similarity,
        text:        r.content,
    }));

    if (passages.length === 0) return [];

    const reranked = await rerankPassages(query, passages);

    return reranked.map(p =>
        `[Source: ${p.source}, Score: ${p.score.toFixed(3)}]\n${p.text}`,
    );
}

interface RawPassage {
    id:          string;
    source:      string;
    cosineScore: number;
    text:        string;
}

interface RankedPassage {
    source: string;
    /** Cosine score if no rerank, otherwise rerank relevance. */
    score:  number;
    text:   string;
}

/**
 * Rerank candidates with the configured Bedrock reranker, falling back to
 * cosine top-K on any failure so the strategist pipeline survives rerank
 * outages, throttling, or model-availability gaps.
 */
async function rerankPassages(
    query:     string,
    passages:  RawPassage[],
): Promise<RankedPassage[]> {
    const cosineTopK: RankedPassage[] = passages
        .slice(0, MAX_KB_PASSAGES)
        .map(p => ({ source: p.source, score: p.cosineScore, text: p.text }));

    if (!reranker || passages.length <= 1) return cosineTopK;

    const candidates: RerankCandidate[] = passages.map(p => ({
        id:   p.id,
        text: p.text,
    }));

    try {
        const ranked = await reranker.rerank(query, candidates, { topK: MAX_KB_PASSAGES });

        // Map rerank IDs back to passage objects in rerank order.
        const byId = new Map(passages.map(p => [p.id, p] as const));
        const out: RankedPassage[] = [];
        for (const r of ranked) {
            const passage = byId.get(r.id);
            if (!passage) continue;
            out.push({
                source: passage.source,
                score:  r.relevanceScore,
                text:   passage.text,
            });
        }
        log('INFO', 'Reranked passages', {
            agent: 'strategist-research',
            input: passages.length,
            output: out.length,
        });
        return out.length > 0 ? out : cosineTopK;
    } catch (err) {
        log('WARN', 'Rerank failed; falling back to cosine top-K', {
            agent: 'strategist-research',
            error: err instanceof Error ? err.message : String(err),
        });
        return cosineTopK;
    }
}

/**
 * Deduplicate KB passages by content only.
 *
 * The score prefix (e.g. `[Source: ..., Score: 0.87]`) differs across
 * queries, so a naive `new Set()` would treat identical text blocks
 * as distinct entries. This helper strips the first line (metadata)
 * before comparison.
 *
 * @param passages - Array of passages with `[Source: ..., Score: ...]\n<content>` format
 * @returns Deduplicated passages joined with separator, empty string if none
 */
function deduplicatePassages(passages: string[]): string {
    const seen = new Set<string>();
    const unique = passages.filter((passage) => {
        // Strip the metadata prefix line for content-only comparison
        const contentOnly = passage.split('\n').slice(1).join('\n');
        if (seen.has(contentOnly)) return false;
        seen.add(contentOnly);
        return true;
    });

    log('INFO', 'Deduplicated passages', { agent: 'strategist-research', total: passages.length, unique: unique.length });

    return unique.length > 0 ? unique.join(KB_CONTEXT_SEPARATOR) : '';
}


// =============================================================================
// USER MESSAGE BUILDER
// =============================================================================

/**
 * Build the user message for the Research Agent.
 *
 * Assembles the job description, KB context, and structured resume data into
 * a prompt with clearly delimited sections for analysis.
 *
 * @param jobDescription - Sanitised job description text
 * @param kbContext - Concatenated KB passages
 * @param resumeData - Structured resume data from pipeline context (may be null)
 * @returns Formatted user message
 */
function buildResearchMessage(
    jobDescription: string,
    kbContext: string,
    resumeData: StructuredResumeData | null,
): string {
    const sections: string[] = [
        '## Job Description',
        '--- BEGIN JOB DESCRIPTION ---',
        jobDescription,
        '--- END JOB DESCRIPTION ---',
        '',
    ];

    if (resumeData) {
        sections.push(
            '## PATH B — Uploaded Resume (FORMATTING REFERENCE ONLY)',
            '',
            '⚠️  CONTENT PROHIBITION — NEVER VIOLATE:',
            'Do NOT copy, paraphrase, or derive any content from this document.',
            '',
            'PERMITTED uses of this document:',
            '  • Section ordering preference',
            '  • Header and contact block format (name, email, location, links)',
            '',
            'PROHIBITED uses — applying any of these is a fabrication error:',
            '  • Any bullet point, phrase, or sentence from this document',
            '  • Summary text, project descriptions, or skill selections',
            '  • Using the skills list to decide what to include or exclude',
            '  • Paraphrasing or reformulating any text from this document',
            '',
            'If a section exists here but has no KB evidence below, leave that section EMPTY.',
            'If this document\'s structure conflicts with archetype section ordering, the ARCHETYPE WINS.',
            '--- BEGIN FORMATTING REFERENCE ---',
            formatResumeForPrompt(resumeData),
            '--- END FORMATTING REFERENCE ---',
            '',
        );
    } else {
        sections.push(
            '## PATH A — KB-Only Generation (no resume provided)',
            'Generate all content entirely from the Knowledge Base evidence below.',
            'No structural constraints from any uploaded document — this is the preferred default.',
            'Do NOT reference or imply any prior resume draft — there is none.',
            'Apply confidence thresholds (STRONG/PARTIAL/ABSENT) as normal.',
            '',
        );
    }

    if (kbContext) {
        sections.push(
            '## Knowledge Base — Portfolio & Project Evidence',
            'The following passages were retrieved from the candidate\'s portfolio documentation.',
            resumeData
                ? 'These are the SOLE CONTENT SOURCE. The formatting reference above contributes no content.'
                : 'Use these as the SOLE evidence source for all skill classifications and bullet generation.',
            'KB constraint passages (containing "NEVER", "ABSENT", "PROHIBITED") are absolute overrides.',
            '',
            kbContext,
            '',
        );
    }

    sections.push('Analyse this job description against the candidate\'s evidence and return the JSON research brief.');

    return sections.join('\n');
}

// =============================================================================
// AGENT EXECUTION
// =============================================================================

/**
 * Agent configuration for the Strategist Research Agent.
 */
const RESEARCH_CONFIG: AgentConfig = {
    agentName: 'strategist-research',
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: RESEARCH_MAX_TOKENS,
    thinkingBudget: RESEARCH_THINKING_BUDGET,
    systemPrompt: RESEARCH_PERSONA_SYSTEM_PROMPT,
};

/**
 * Execute the Strategist Research Agent.
 *
 * 1. Sanitises the job description input
 * 2. Queries the Bedrock KB with userId metadata filter — 4 factual queries in parallel:
 *    portfolio evidence, skill signals, work history, DORA outcome metrics.
 *    Constraint documents (generation rules, honesty boundaries, writing voice, archetypes,
 *    achievements) are injected statically from RESUME_CONSTRAINTS — not retrieved via
 *    vector search, which cannot find system-level pages lacking userId metadata.
 * 3. Reads structured resume data from the pipeline context (fetched by trigger)
 * 4. Runs Haiku 4.5 to produce a structured research brief
 *
 * @param ctx - Pipeline context with job description, resumeData, and userId
 * @returns Research result with verified/partial/gap skill classification
 */
export async function executeResearchAgent(
    ctx: StrategistPipelineContext,
): Promise<AgentResult<StrategistResearchResult>> {
    // 1. Sanitise input
    log('INFO', 'Analysing JD', { agent: 'strategist-research', pipelineId: ctx.pipelineId, targetRole: ctx.targetRole });
    const { sanitised, warnings, injectionDetected } = inputSanitiser.sanitiseWithWarnings(ctx.jobDescription);
    const jd = piiScrubber.scrub(sanitised).redacted;

    if (injectionDetected) {
        log('WARN', 'Injection attempt detected — proceeding with sanitised input', { agent: 'strategist-research' });
    }
    for (const warning of warnings) {
        log('WARN', warning, { agent: 'strategist-research' });
    }

    // 2. Query RDS pgvector store — factual portfolio evidence (4 queries, userId-scoped).
    //
    //    Constraint documents (agent-guide, gap-awareness, voice-library, role-archetypes,
    //    achievements) are embedded statically in RESUME_CONSTRAINTS — no DB lookup needed.
    //    Factual queries target the user's ingested repo chunks via HNSW + optional rerank.
    let kbContext = '';

    const resumeConstraints = RESUME_CONSTRAINTS;
    const { userId } = ctx;
    const store = RdsVectorStore.fromEnvironment();

    const half = Math.min(500, Math.floor(jd.length / 2));
    const full = Math.min(1000, jd.length);

    const [factual1, factual2, factual3, factual4] = await Promise.all([
        // Query 1 — full JD text: surfaces skill/tech matches from across the user's docs
        querySingleRds(jd.substring(0, full), userId, store),
        // Query 2 — JD tail + experience signal: surfaces role-relevant work history
        querySingleRds(`professional experience skills qualifications ${jd.substring(half)}`, userId, store),
        // Query 3 — JD-aware project query: surfaces project templates matching this role
        querySingleRds(`portfolio project implementation achievements ${jd.substring(0, half)}`, userId, store),
        // Query 4 — DORA metrics and outcome measurements
        querySingleRds('DORA metrics lead time MTTR change failure rate deployment frequency outcome measurement pipeline performance', userId, store),
    ]);

    const allFactualPassages = [...factual1, ...factual2, ...factual3, ...factual4];
    kbContext = deduplicatePassages(allFactualPassages);

    log('INFO', 'Retrieval complete', {
        agent: 'strategist-research',
        userId,
        factualSizeKb: kbContext.length > 0 ? (kbContext.length / 1024).toFixed(1) : 'empty',
        constraintsSizeKb: (resumeConstraints.length / 1024).toFixed(1),
    });

    // 3. Read resume from pipeline context (fetched at trigger time)
    const resumeData = ctx.resumeData;
    if (!resumeData) {
        log('INFO', 'No resume data — build-from-scratch mode', { agent: 'strategist-research' });
    } else {
        log('INFO', 'Resume loaded from context', { agent: 'strategist-research', profileName: resumeData.profile.name });
    }

    // 4. Build user message
    const userMessage = buildResearchMessage(jd, kbContext, resumeData);

    // 5. Run agent
    const result = await runAgent<StrategistResearchResult>({
        config: RESEARCH_CONFIG,
        userMessage,
        parseResponse: (text) => {
            const parsed = parseJsonResponse<StrategistResearchResult>(text, 'strategist-research');

            // Ensure arrays are always arrays (defensive against LLM output)
            // and provide safe defaults for nested objects the LLM might omit
            return {
                ...parsed,
                targetRole: parsed.targetRole ?? 'Unknown Role',
                targetCompany: parsed.targetCompany ?? 'Unknown Company',
                seniority: parsed.seniority ?? 'unspecified',
                domain: parsed.domain ?? 'unspecified',
                hardRequirements: Array.isArray(parsed.hardRequirements) ? parsed.hardRequirements : [],
                softRequirements: Array.isArray(parsed.softRequirements) ? parsed.softRequirements : [],
                implicitRequirements: Array.isArray(parsed.implicitRequirements) ? parsed.implicitRequirements : [],
                verifiedMatches: Array.isArray(parsed.verifiedMatches) ? parsed.verifiedMatches : [],
                partialMatches: Array.isArray(parsed.partialMatches) ? parsed.partialMatches : [],
                gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
                technologyInventory: {
                    languages: Array.isArray(parsed.technologyInventory?.languages) ? parsed.technologyInventory.languages : [],
                    frameworks: Array.isArray(parsed.technologyInventory?.frameworks) ? parsed.technologyInventory.frameworks : [],
                    infrastructure: Array.isArray(parsed.technologyInventory?.infrastructure) ? parsed.technologyInventory.infrastructure : [],
                    tools: Array.isArray(parsed.technologyInventory?.tools) ? parsed.technologyInventory.tools : [],
                    methodologies: Array.isArray(parsed.technologyInventory?.methodologies) ? parsed.technologyInventory.methodologies : [],
                },
                experienceSignals: {
                    yearsExpected: parsed.experienceSignals?.yearsExpected ?? 'unspecified',
                    domainExperience: parsed.experienceSignals?.domainExperience ?? 'unspecified',
                    leadershipExpectation: parsed.experienceSignals?.leadershipExpectation ?? 'none specified',
                    scaleIndicators: parsed.experienceSignals?.scaleIndicators ?? 'unspecified',
                },
                overallFitRating: parsed.overallFitRating ?? 'STRETCH',
                fitSummary: parsed.fitSummary ?? 'Analysis incomplete — insufficient data for assessment.',
                resumeData,
                kbContext,
                resumeConstraints,
            };
        },
        pipelineContext: {
            pipelineId: ctx.pipelineId,
            environment: ctx.environment,
            cumulativeTokens: ctx.cumulativeTokens,
            cumulativeCostUsd: ctx.cumulativeCostUsd,
        },
    });

    log('INFO', 'Brief generated', {
        agent: 'strategist-research',
        fitRating: result.data.overallFitRating,
        verified: result.data.verifiedMatches.length,
        partial: result.data.partialMatches.length,
        gaps: result.data.gaps.length,
    });

    return result;
}
