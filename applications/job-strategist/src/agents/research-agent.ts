/**
 * @format
 * Strategist Research Agent — KB Retrieval, Resume Parsing & Gap Analysis
 *
 * First agent in the 3-agent strategist pipeline. Receives the raw
 * job description, queries the Pinecone Knowledge Base for portfolio
 * and project data, fetches the latest resume from DynamoDB, and
 * produces a structured research brief with verified/partial/gap
 * skill classification.
 *
 * Uses Haiku 4.5 for cost-efficient extraction and analysis.
 *
 * Pipeline position: API → **Research** → Strategist → Coach → DynamoDB
 */

import {
    BedrockAgentRuntimeClient,
    RetrieveCommand,
} from '@aws-sdk/client-bedrock-agent-runtime';

import { runAgent, parseJsonResponse, InputSanitiser, BedrockReranker, log } from '@bedrock/shared';
import type { IReranker, PiiPattern, RerankCandidate } from '@bedrock/shared';
import { formatResumeForPrompt } from '../services/resume-service.js';
import { RESEARCH_PERSONA_SYSTEM_PROMPT } from '../prompts/research-persona.js';
import { RESUME_CONSTRAINTS } from '../prompts/resume-constraints.js';

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
import type {
    AgentConfig,
    AgentResult,
    StructuredResumeData,
    StrategistPipelineContext,
    StrategistResearchResult,
} from '@bedrock/shared';

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

/** Knowledge Base ID for Pinecone retrieval */
const KNOWLEDGE_BASE_ID = process.env.KNOWLEDGE_BASE_ID ?? '';

/**
 * Final number of KB passages handed to the LLM. With reranking enabled,
 * we over-fetch this many × RETRIEVE_OVERFETCH from the KB and let the
 * cross-encoder pick the best slice.
 */
const MAX_KB_PASSAGES = 15;

/**
 * Multiplier applied to MAX_KB_PASSAGES when fetching from the KB so the
 * reranker has a richer candidate pool to choose from. 50 candidates is
 * the industry baseline; 15 × 4 = 60 trims to 50 inside the rerank call
 * to stay under the Bedrock Rerank per-call cap of 100.
 */
const RETRIEVE_OVERFETCH = 4;
const MAX_RERANK_CANDIDATES = 50;

/**
 * Reranking is best-effort: a thrown rerank call falls back to the
 * pre-rerank top-MAX_KB_PASSAGES of the KB result set. Set
 * RERANKER_DISABLED=1 to bypass entirely (e.g. for cost-controlled runs
 * or when the rerank model is unavailable in the deployment region).
 */
const RERANKER_DISABLED = process.env.RERANKER_DISABLED === '1';

// =============================================================================
// CLIENTS
// =============================================================================

const bedrockAgentClient = new BedrockAgentRuntimeClient({});

const reranker: IReranker | null = RERANKER_DISABLED
    ? null
    : BedrockReranker.fromEnvironment();

// =============================================================================
// KNOWLEDGE BASE RETRIEVAL
// =============================================================================

/**
 * Execute a single KB retrieval query filtered to a specific user's vectors.
 *
 * The `userId` metadata filter restricts results to documents indexed for
 * this user — prevents cross-user data leakage and ensures KB evidence
 * is grounded in the candidate's own portfolio, not a shared corpus.
 *
 * Retrieval flow (pick #5 in the Tucaken-product roadmap):
 *   1. Over-fetch up to RETRIEVE_OVERFETCH × MAX_KB_PASSAGES candidates
 *      (capped at MAX_RERANK_CANDIDATES) from the KB by cosine similarity.
 *   2. Rerank with a Bedrock cross-encoder against the original query.
 *   3. Take the top MAX_KB_PASSAGES from the reranked order.
 *   4. On any rerank failure, fall back to the cosine-only top-K so the
 *      strategist pipeline never breaks because of a rerank-time error.
 *
 * @param query - Search query text for the Knowledge Base
 * @param userId - Authenticated user ID for metadata filtering
 * @returns Raw passages with source/score metadata prefix
 */
async function querySingleKb(query: string, userId: string): Promise<string[]> {
    if (!KNOWLEDGE_BASE_ID) {
        return [];
    }

    const overfetch = Math.min(MAX_KB_PASSAGES * RETRIEVE_OVERFETCH, MAX_RERANK_CANDIDATES);

    log('INFO', 'Querying KB', {
        agent:        'strategist-research',
        queryPreview: query.substring(0, 80),
        retrieveK:    overfetch,
        finalK:       MAX_KB_PASSAGES,
        rerank:       reranker !== null,
    });

    const command = new RetrieveCommand({
        knowledgeBaseId: KNOWLEDGE_BASE_ID,
        retrievalQuery: { text: query },
        retrievalConfiguration: {
            vectorSearchConfiguration: {
                numberOfResults: overfetch,
                filter: {
                    equals: { key: 'userId', value: userId },
                },
            },
        },
    });

    const response = await bedrockAgentClient.send(command);
    const results = response.retrievalResults ?? [];

    /** Tagged candidate set so we can map rerank IDs → original passages. */
    const passages = results
        .filter(r => Boolean(r.content?.text))
        .map((r, i) => ({
            id:     String(i),
            source: r.location?.s3Location?.uri ?? 'unknown',
            cosineScore: r.score ?? 0,
            text:   r.content!.text!,
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

    return unique.length > 0 ? unique.join('\n\n---\n\n') : '';
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

    if (injectionDetected) {
        log('WARN', 'Injection attempt detected — proceeding with sanitised input', { agent: 'strategist-research' });
    }
    for (const warning of warnings) {
        log('WARN', warning, { agent: 'strategist-research' });
    }

    // 2. Query Knowledge Base — factual portfolio evidence (4 queries, userId-scoped)
    //
    //    Constraint documents (agent-guide, gap-awareness, voice-library, role-archetypes,
    //    achievements) are system-level pages with no userId attribute in the Pinecone index.
    //    They CANNOT be retrieved via userId-filtered vector search — queries would return
    //    zero results. These pages are embedded statically in RESUME_CONSTRAINTS and injected
    //    directly, replicating the deterministic delivery that wiki-mcp previously provided.
    //
    //    Factual queries (4): portfolio evidence, skill signals, DORA outcome metrics.
    //    These are userId-scoped because they must reflect this candidate's own projects.
    let kbContext = '';

    // Constraint pages are always present — static embed, no KB lookup required.
    const resumeConstraints = RESUME_CONSTRAINTS;

    const hasKb = Boolean(KNOWLEDGE_BASE_ID);
    const { userId } = ctx;

    if (hasKb) {
        const [factual1, factual2, factual3, factual4] = await Promise.all([
            // Query 1 — full JD text: surfaces skill/tech matches from across the KB
            querySingleKb(sanitised.substring(0, 1000), userId),
            // Query 2 — JD tail + experience signal: surfaces role-relevant work history
            querySingleKb(`professional experience skills qualifications ${sanitised.substring(500, 1000)}`, userId),
            // Query 3 — JD-aware project query: surfaces project templates matching this role
            querySingleKb(`portfolio project implementation achievements ${sanitised.substring(0, 500)}`, userId),
            // Query 4 — DORA metrics and outcome measurements: ensures every bullet can be
            // grounded in a concrete outcome (lead time, MTTR, CFR, deployment frequency).
            // Without this query the agent sees technical inventory but no outcome numbers.
            querySingleKb('DORA metrics lead time MTTR change failure rate deployment frequency outcome measurement pipeline performance', userId),
        ]);

        // Factual context — portfolio evidence for achievement bullet verification
        const allFactualPassages = [...factual1, ...factual2, ...factual3, ...factual4];
        kbContext = deduplicatePassages(allFactualPassages);

        log('INFO', 'Retrieval complete', {
            agent: 'strategist-research',
            userId,
            factualSizeKb: kbContext.length > 0 ? (kbContext.length / 1024).toFixed(1) : 'empty',
            constraintsSizeKb: (resumeConstraints.length / 1024).toFixed(1),
        });
    } else {
        log('INFO', 'Retrieval skipped — KNOWLEDGE_BASE_ID not configured', { agent: 'strategist-research' });
    }

    // 3. Read resume from pipeline context (fetched at trigger time)
    const resumeData = ctx.resumeData;
    if (!resumeData) {
        log('INFO', 'No resume data — build-from-scratch mode', { agent: 'strategist-research' });
    } else {
        log('INFO', 'Resume loaded from context', { agent: 'strategist-research', profileName: resumeData.profile.name });
    }

    // 4. Build user message
    const userMessage = buildResearchMessage(sanitised, kbContext, resumeData);

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
