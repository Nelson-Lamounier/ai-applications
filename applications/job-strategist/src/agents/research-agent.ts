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

import { z } from 'zod';
import {
    runAgent,
    parseJsonResponse,
    InputSanitiser,
    PiiScrubber,
    BedrockReranker,
    RdsVectorStore,
    RdsExperienceVectorStore,
    TitanEmbeddingProvider,
    RdsDsaTopicRepository,
    log,
} from '@bedrock/shared';
import { loadCareerHistory, formatCareerHistory } from './career-history.js';
import { computeKbStats } from '../lib/kb-stats.js';
import type { Pool } from 'pg';
import type {
    AgentConfig,
    AgentResult,
    IReranker,
    PiiPattern,
    QueryParams,
    RerankCandidate,
    SimilarityResult,
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

/** Maximum output tokens for the forced tool_use research brief. */
const RESEARCH_MAX_TOKENS = 16000;

/** Max pgvector passages surfaced to the LLM after optional reranking. */
const MAX_KB_PASSAGES = 15;

/**
 * Over-fetch factor — retrieve this × MAX_KB_PASSAGES candidates so the
 * cross-encoder reranker has a richer pool. 15 × 4 = 60, under the 100-doc
 * Bedrock Rerank API cap.
 */
const RETRIEVE_OVERFETCH = 4;

const RERANKER_DISABLED = process.env.RERANKER_DISABLED === '1';

/**
 * Minimum RAW cosine similarity for a retrieved passage to enter the LLM
 * context. Below this, retrieval is effectively noise (orthogonal vectors sit
 * near ~0; real portfolio↔JD matches land ~0.2–0.7). Passages under the floor
 * are dropped so the grounding verifier can honestly emit NOT_GROUNDED instead
 * of the model fabricating from irrelevant chunks. Threshold the COSINE, never
 * the rerank score (which is a tight, near-degenerate band). Env-tunable.
 */
const MIN_COSINE = Number.parseFloat(process.env.KB_MIN_COSINE ?? '0.20');

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
async function querySingleRds(
    query: string,
    userId: string,
    store: { querySimilar(p: QueryParams): Promise<SimilarityResult[]> },
): Promise<string[]> {
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

    // Floor on RAW cosine (not the hybrid/RRF `similarity`, which is rank-derived).
    // Drops near-orthogonal noise before it can reach the LLM or the reranker.
    const relevant = results.filter(r => r.cosine >= MIN_COSINE);
    if (relevant.length === 0) {
        const topCosine = results.length > 0 ? Math.max(...results.map(r => r.cosine)) : 0;
        log('INFO', 'No passages cleared the cosine floor — returning empty context', {
            agent:     'strategist-research',
            retrieved: results.length,
            minCosine: MIN_COSINE,
            topCosine: Number(topCosine.toFixed(3)),
        });
        return [];
    }

    const passages = relevant.map((r, i) => ({
        id:          String(i),
        source:      `${r.repoFullName}/${r.filePath}`,
        cosineScore: r.cosine,
        text:        r.content,
    }));

    const reranked = await rerankPassages(query, passages);

    // Surface BOTH scores: cosine is authoritative (floor + grounding), rerank
    // drives ordering. A 0.31-cosine passage must not be mislabelled by a 0.015 rerank.
    return reranked.map(p =>
        `[Source: ${p.source}, Cosine: ${p.cosineScore.toFixed(3)}, Rerank: ${p.rerankScore.toFixed(3)}]\n${p.text}`,
    );
}

interface RawPassage {
    id:          string;
    source:      string;
    cosineScore: number;
    text:        string;
}

interface RankedPassage {
    source:      string;
    /** Authoritative absolute similarity — used for the floor + grounding. */
    cosineScore: number;
    /** Rerank relevance (drives ordering). Equals cosineScore when rerank is off. */
    rerankScore: number;
    text:        string;
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
        .map(p => ({ source: p.source, cosineScore: p.cosineScore, rerankScore: p.cosineScore, text: p.text }));

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
                source:      passage.source,
                cosineScore: passage.cosineScore,
                rerankScore: r.relevanceScore,
                text:        passage.text,
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
    careerHistorySection = '',
    dsaCatalog = '',
    projectEvidenceSection = '',
    educationSection = '',
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

    if (projectEvidenceSection) {
        sections.push(
            '## Project Case Studies — Documented Portfolio Projects (factual, citeable evidence)',
            'These are the candidate\'s own documented projects (curated from their real work). Treat as',
            'factual evidence ALONGSIDE the KB passages above — a JD skill demonstrated by a project\'s',
            'stack or decisions is STRONG evidence, and you may name the project as its source citation.',
            '',
            projectEvidenceSection,
            '',
        );
    }

    if (careerHistorySection) {
        sections.push(careerHistorySection);
        sections.push('');
    }

    if (educationSection) {
        sections.push(educationSection);
        sections.push('');
    }

    sections.push(
        '## Interview-prep pillar classification',
        'Classify the role\'s interview-prep focus from the JOB DESCRIPTION LANGUAGE ONLY and emit it as `pillarClassification`.',
        '- primaryPillar = "swe-general" UNLESS the JD clearly emphasizes one of:',
        '  • "swe-dsa" — algorithms/data-structures/LeetCode/coding-interview/complexity',
        '  • "devops-sre-platform" — Kubernetes/Terraform/cloud/SRE/on-call/incident/SLO/reliability/platform',
        '  • "ai-engineering" — LLM/RAG/embeddings/vector/prompt/evals/fine-tune/agent/MCP/inference',
        '- secondaryPillars: every OTHER pillar the JD also applies to (multi-label; [] if none).',
        '- jdEvidenceTokens: the VERBATIM JD phrases that drove the choice (≥1 when primaryPillar≠"swe-general").',
        '- classificationNote: one line stating this is inferred from JD language, not guaranteed.',
        '',
    );

    if (dsaCatalog) {
        sections.push(
            '## DSA topic catalog — map the JD to these CANONICAL names ONLY',
            dsaCatalog,
            '',
            'Emit dsaTopicCalibration.likelyTopics = the subset this JD implies (canonicalName MUST be from the catalog above),' +
            ' each with a confidence (0..1), a one-line rationale, and the exact jdEvidenceQuote phrase.' +
            ' If the role implies NO DSA round (e.g. senior platform/infra with no coding signal), return likelyTopics: [].' +
            ' honestyNote is mandatory: state these are inferred from JD language, not guaranteed.',
            '',
        );
    }

    sections.push('Analyse this job description against the candidate\'s evidence and return the JSON research brief.');

    return sections.join('\n');
}

// =============================================================================
// AGENT EXECUTION
// =============================================================================

// =============================================================================
// STRUCTURED OUTPUT — tool schema + Zod safety-net
// =============================================================================

const JOB_REQUIREMENT_SCHEMA = {
    type: 'object',
    properties: {
        skill:        { type: 'string' },
        context:      { type: 'string' },
        disqualifying: { type: 'boolean' },
    },
    required: ['skill', 'context'],
    additionalProperties: false,
};

const STR_ARRAY = { type: 'array', items: { type: 'string' } };

/** Tool the research model is forced to call. Non-model fields (resumeData,
 *  kbContext, resumeConstraints) are injected after validation, not produced
 *  by the model, so they are absent from the schema. */
const RESEARCH_TOOL = {
    name: 'emit_research_brief',
    description: 'Emit the structured job-fit research brief.',
    inputSchema: {
        type: 'object',
        properties: {
            targetRole:    { type: 'string' },
            targetCompany: { type: 'string' },
            seniority:     { type: 'string' },
            domain:        { type: 'string' },
            hardRequirements: { type: 'array', items: JOB_REQUIREMENT_SCHEMA },
            softRequirements: { type: 'array', items: JOB_REQUIREMENT_SCHEMA },
            implicitRequirements: STR_ARRAY,
            technologyInventory: {
                type: 'object',
                properties: {
                    languages: STR_ARRAY, frameworks: STR_ARRAY, infrastructure: STR_ARRAY,
                    tools: STR_ARRAY, methodologies: STR_ARRAY,
                },
                required: ['languages', 'frameworks', 'infrastructure', 'tools', 'methodologies'],
                additionalProperties: false,
            },
            experienceSignals: {
                type: 'object',
                properties: {
                    yearsExpected:         { type: 'string' },
                    domainExperience:      { type: 'string' },
                    leadershipExpectation: { type: 'string' },
                    scaleIndicators:       { type: 'string' },
                },
                required: ['yearsExpected', 'domainExperience', 'leadershipExpectation', 'scaleIndicators'],
                additionalProperties: false,
            },
            verifiedMatches: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        skill:         { type: 'string' },
                        sourceCitation: { type: 'string' },
                        depth:         { type: 'string', enum: ['surface', 'working', 'expert'] },
                        recency:       { type: 'string' },
                    },
                    required: ['skill', 'sourceCitation', 'depth', 'recency'],
                    additionalProperties: false,
                },
            },
            partialMatches: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        skill:                 { type: 'string' },
                        gapDescription:        { type: 'string' },
                        transferableFoundation: { type: 'string' },
                        framingSuggestion:     { type: 'string' },
                    },
                    required: ['skill', 'gapDescription', 'transferableFoundation', 'framingSuggestion'],
                    additionalProperties: false,
                },
            },
            gaps: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        skill:                   { type: 'string' },
                        gapType:                 { type: 'string', enum: ['hard', 'soft'] },
                        impactSeverity:          { type: 'string', enum: ['blocking', 'significant', 'minor'] },
                        disqualifyingAssessment: { type: 'string' },
                    },
                    required: ['skill', 'gapType', 'impactSeverity', 'disqualifyingAssessment'],
                    additionalProperties: false,
                },
            },
            overallFitRating: { type: 'string', enum: ['STRONG FIT', 'REASONABLE FIT', 'STRETCH', 'REACH'] },
            fitSummary:        { type: 'string' },
            pillarClassification: {
                type: 'object',
                properties: {
                    primaryPillar: { type: 'string', enum: ['swe-general','swe-dsa','devops-sre-platform','ai-engineering'] },
                    secondaryPillars: { type: 'array', items: { type: 'string', enum: ['swe-general','swe-dsa','devops-sre-platform','ai-engineering'] } },
                    confidence: { type: 'number' },
                    jdEvidenceTokens: STR_ARRAY,
                    classificationNote: { type: 'string' },
                },
                required: ['primaryPillar','secondaryPillars','confidence','jdEvidenceTokens','classificationNote'],
                additionalProperties: false,
            },
            dsaTopicCalibration: {
                type: 'object',
                properties: {
                    likelyTopics: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                canonicalName:   { type: 'string' },
                                displayName:     { type: 'string' },
                                confidence:      { type: 'number' },
                                rationale:       { type: 'string' },
                                jdEvidenceQuote: { type: 'string' },
                            },
                            required: ['canonicalName','displayName','confidence','rationale','jdEvidenceQuote'],
                            additionalProperties: false,
                        },
                    },
                    honestyNote: { type: 'string' },
                },
                required: ['likelyTopics','honestyNote'],
                additionalProperties: false,
            },
        },
        required: [
            'targetRole', 'targetCompany', 'seniority', 'domain',
            'hardRequirements', 'softRequirements', 'implicitRequirements',
            'technologyInventory', 'experienceSignals',
            'verifiedMatches', 'partialMatches', 'gaps',
            'overallFitRating', 'fitSummary',
        ],
        additionalProperties: false,
    },
};

const JobRequirementSchema = z.object({
    skill: z.string(),
    context: z.string(),
    disqualifying: z.boolean().optional(),
}).strict();

/** Runtime safety-net for the model-produced fields only. */
const ResearchModelSchema = z.object({
    targetRole: z.string(),
    targetCompany: z.string(),
    seniority: z.string(),
    domain: z.string(),
    hardRequirements: z.array(JobRequirementSchema),
    softRequirements: z.array(JobRequirementSchema),
    implicitRequirements: z.array(z.string()),
    technologyInventory: z.object({
        languages: z.array(z.string()),
        frameworks: z.array(z.string()),
        infrastructure: z.array(z.string()),
        tools: z.array(z.string()),
        methodologies: z.array(z.string()),
    }).strict(),
    experienceSignals: z.object({
        yearsExpected: z.string(),
        domainExperience: z.string(),
        leadershipExpectation: z.string(),
        scaleIndicators: z.string(),
    }).strict(),
    verifiedMatches: z.array(z.object({
        skill: z.string(),
        sourceCitation: z.string(),
        depth: z.enum(['surface', 'working', 'expert']),
        recency: z.string(),
    }).strict()),
    partialMatches: z.array(z.object({
        skill: z.string(),
        gapDescription: z.string(),
        transferableFoundation: z.string(),
        framingSuggestion: z.string(),
    }).strict()),
    gaps: z.array(z.object({
        skill: z.string(),
        gapType: z.enum(['hard', 'soft']),
        impactSeverity: z.enum(['blocking', 'significant', 'minor']),
        disqualifyingAssessment: z.string(),
    }).strict()),
    overallFitRating: z.enum(['STRONG FIT', 'REASONABLE FIT', 'STRETCH', 'REACH']),
    fitSummary: z.string(),
    pillarClassification: z.object({
        primaryPillar: z.enum(['swe-general','swe-dsa','devops-sre-platform','ai-engineering']),
        secondaryPillars: z.array(z.enum(['swe-general','swe-dsa','devops-sre-platform','ai-engineering'])),
        confidence: z.number(),
        jdEvidenceTokens: z.array(z.string()),
        classificationNote: z.string(),
    }).strict().optional(),
    dsaTopicCalibration: z.object({
        likelyTopics: z.array(z.object({
            canonicalName: z.string(), displayName: z.string(), confidence: z.number(),
            rationale: z.string(), jdEvidenceQuote: z.string(),
        }).strict()),
        honestyNote: z.string(),
    }).strict().optional(),
}).strict();

/**
 * Validate the forced tool_use output and merge the injected (non-model)
 * pipeline fields. Fail-fast: an invalid brief must not reach the
 * Strategist agent / RDS (structure-output-checklist §7).
 *
 * @param raw      - Parsed tool input (model output)
 * @param injected - Pipeline-owned fields not produced by the model
 */
export function validateResearchResult(
    raw: unknown,
    injected: {
        resumeData: StructuredResumeData | null;
        kbContext: string;
        resumeConstraints: string;
    },
): StrategistResearchResult {
    const validated = ResearchModelSchema.safeParse(raw);
    if (!validated.success) {
        throw new Error(
            `strategist-research: research brief failed schema validation: ${validated.error.message}`,
        );
    }
    return {
        ...validated.data,
        ...injected,
        kbRetrievalStats: computeKbStats(injected.kbContext, MIN_COSINE),
    } as StrategistResearchResult;
}

/**
 * Agent configuration for the Strategist Research Agent.
 *
 * thinkingBudget 0: forced tool_use (constrained decoding) is incompatible
 * with extended thinking on Claude. See structure-output-checklist §2.
 */
const RESEARCH_CONFIG: AgentConfig = {
    agentName: 'strategist-research',
    modelId: EFFECTIVE_MODEL_ID,
    maxTokens: RESEARCH_MAX_TOKENS,
    thinkingBudget: 0,
    systemPrompt: RESEARCH_PERSONA_SYSTEM_PROMPT,
    tool: RESEARCH_TOOL,
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
    pool?: Pool,
    projectEvidenceBlock = '',
    educationBlock = '',
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

    let career: string[] = [];
    try {
        const careerStore = RdsExperienceVectorStore.fromEnvironment();
        career = await querySingleRds(`work history roles responsibilities ${jd.substring(0, half)}`, userId, careerStore);
    } catch (e) {
        log('WARN', 'career vector query failed (non-fatal)', { error: (e as Error).message });
    }
    const allFactualPassages = [...factual1, ...factual2, ...factual3, ...factual4, ...career];
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

    // 4. Load structured career history (citeable evidence — distinct from resume formatting ref)
    let careerHistorySection = '';
    if (pool) {
        try {
            const careerEntries = await loadCareerHistory(pool, userId);
            careerHistorySection = formatCareerHistory(careerEntries);
        } catch (e) {
            log('WARN', 'career history load failed (non-fatal)', { error: (e as Error).message });
        }
    }

    // 5. Load DSA topic catalog and build catalog section (fail-open)
    let dsaCatalog = '';
    if (pool) {
        try {
            const topics = await new RdsDsaTopicRepository(pool).listTopics();
            dsaCatalog = topics
                .map(t => `- ${t.canonicalName} (${t.displayName}) [${t.category}] signals: ${t.jdSignalKeywords.join(', ')}`)
                .join('\n');
        } catch {
            /* fail-open: no catalog → model emits empty calibration or omits */
        }
    }

    // 6. Build user message
    const userMessage = buildResearchMessage(jd, kbContext, resumeData, careerHistorySection, dsaCatalog, projectEvidenceBlock, educationBlock);

    // 7. Run agent
    const result = await runAgent<StrategistResearchResult>({
        config: RESEARCH_CONFIG,
        userMessage,
        parseResponse: (text) => {
            // text is the forced tool_use input as JSON. parseJsonResponse
            // unwraps it; validateResearchResult fails fast on any schema
            // deviation instead of papering over it with defaults.
            const raw = parseJsonResponse<unknown>(text, 'strategist-research');
            return validateResearchResult(raw, { resumeData, kbContext, resumeConstraints });
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
