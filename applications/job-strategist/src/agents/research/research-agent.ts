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
import { loadCareerHistory, formatCareerHistory, type CareerEntry } from '../evidence/career-history.js';
import { jdRetrievalQueries, formatJdExtraction } from '../jd/jd-extractor.js';
import { assessmentsToMatching } from './research-assessment.js';
import { canonicalJdSkills } from '../../ats/context/canonical-jd-skills.js';
import { computeKbStats } from '../../lib/grounding/kb-stats.js';
import type { Pool } from 'pg';
import type {
    AgentConfig,
    AgentResult,
    IReranker,
    JdDimensionMix,
    JdSignal,
    PiiPattern,
    QueryParams,
    RerankCandidate,
    ResearchMatching,
    RetrievalPrefilter,
    SimilarityResult,
    StructuredResumeData,
    StrategistPipelineContext,
    TechTransferGroup,
} from '@bedrock/shared';
import { formatResumeForPrompt } from '../../services/resume-service.js';
import { RESEARCH_PERSONA_META, RESEARCH_PERSONA_SYSTEM_PROMPT } from '../../prompts/research-persona.js';
import { RESUME_CONSTRAINTS } from '../../prompts/resume-constraints.js';

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

/**
 * Single authoritative JD sanitisation: injection-strip (InputSanitiser) then
 * PII-scrub. Call ONCE at pipeline entry so every consumer (JD-extractor,
 * Research, semantic cache) inherits the neutralised value — previously only
 * Research sanitised, leaving the extractor + cache on raw input.
 */
export function sanitiseJobDescription(raw: string): {
    clean: string; warnings: string[]; injectionDetected: boolean;
} {
    const { sanitised, warnings, injectionDetected } = inputSanitiser.sanitiseWithWarnings(raw);
    return { clean: piiScrubber.scrub(sanitised).redacted, warnings, injectionDetected };
}

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

/**
 * Customer-facing/support weight (customerFacing + supportOps, each 0-100) at or
 * above which a role is treated as "support-heavy". For such roles the doc-KB
 * (engineering repos) grounds support competencies poorly, so we boost
 * career_history retrieval and instruct the matcher to ground support evidence
 * in the candidate's actual support/customer-facing roles. Env-tunable.
 */
const SUPPORT_HEAVY_THRESHOLD = Number.parseInt(process.env['SUPPORT_HEAVY_THRESHOLD'] ?? '40', 10);

/**
 * Combined customer-facing + support-ops weight from the JD's dimensionMix.
 * Absent/zero dimensionMix (older runs) yields 0 — below any sane threshold,
 * so behaviour is unchanged.
 */
function customerSupportWeight(dimensionMix?: JdDimensionMix | null): number {
    return (dimensionMix?.customerFacing ?? 0) + (dimensionMix?.supportOps ?? 0);
}

/**
 * True when the role is support/customer-heavy (weight >= threshold). Pure —
 * unit-testable without touching the vector stores.
 */
export function isSupportHeavy(dimensionMix?: JdDimensionMix | null, threshold: number = SUPPORT_HEAVY_THRESHOLD): boolean {
    return customerSupportWeight(dimensionMix) >= threshold;
}

/**
 * The matcher-facing grounding note prepended to kbContext for support-heavy
 * roles. Returns '' below the threshold (no note → behaviour unchanged). Pure.
 */
export function supportGroundingNote(weight: number, threshold: number = SUPPORT_HEAVY_THRESHOLD): string {
    if (weight < threshold) return '';
    return `NOTE: This is a customer-facing/support-heavy role (customerFacing+support = ${weight}%). Ground customer-support, troubleshooting, communication, root-cause, and relationship competencies in BOTH the candidate's project/repository evidence AND their support/customer-facing career history. PREFER demonstrated project/repository work where it exists — a project highlight or challenge (e.g. debugging a silent IAM deny, fixing data-correctness incidents, writing ADRs/runbooks) is first-person proof of these competencies — and use the career history to corroborate, not replace it. Cite whichever source the evidence actually comes from.`;
}

/**
 * Resolve the support-heavy retrieval boost from the JD signal. Pure + fail-open:
 * absent/zero dimensionMix → default career limit and empty note (behaviour
 * unchanged). When support-heavy, doubles the career passage limit so support
 * competencies are grounded in the candidate's actual support/customer-facing
 * roles rather than the structurally-weak engineering doc-KB.
 */
function resolveSupportBoost(dimensionMix?: JdDimensionMix | null): {
    weight: number;
    careerLimit: number;
    groundingNote: string;
} {
    const weight = customerSupportWeight(dimensionMix);
    const heavy = isSupportHeavy(dimensionMix);
    return {
        weight,
        careerLimit: heavy ? MAX_KB_PASSAGES * 2 : MAX_KB_PASSAGES,
        groundingNote: supportGroundingNote(weight),
    };
}

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
export async function querySingleRds(
    query: string,
    userId: string,
    store: { querySimilar(p: QueryParams): Promise<SimilarityResult[]> },
    maxPassages: number = MAX_KB_PASSAGES,
    prefilter?: RetrievalPrefilter,
): Promise<string[]> {
    // Defence in depth: a blank query embeds to nothing and Bedrock Titan rejects
    // it with "minLength: 1, actual: 0", crashing the pipeline. No query string
    // (from any caller) should ever reach the embedder empty — skip retrieval.
    if (query.trim().length === 0) {
        log('INFO', 'Empty retrieval query — skipping embedding/rerank', { agent: 'strategist-research' });
        return [];
    }

    const finalK = Math.max(1, maxPassages);
    const overfetch = finalK * RETRIEVE_OVERFETCH;

    log('INFO', 'Querying RDS vector store', {
        agent:        'strategist-research',
        queryPreview: piiScrubber.scrub(query.substring(0, 80)).redacted,
        retrieveK:    overfetch,
        finalK,
        rerank:       reranker !== null,
    });

    const queryEmbedding = await embedder.embed(query);
    const results = await store.querySimilar({
        userId,
        queryEmbedding,
        queryText:  query,
        useHybrid:  true,
        limit:      overfetch,
        prefilter,
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

    const reranked = await rerankPassages(query, passages, finalK);

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
    finalK:    number = MAX_KB_PASSAGES,
): Promise<RankedPassage[]> {
    const cosineTopK: RankedPassage[] = passages
        .slice(0, finalK)
        .map(p => ({ source: p.source, cosineScore: p.cosineScore, rerankScore: p.cosineScore, text: p.text }));

    if (!reranker || passages.length <= 1) return cosineTopK;

    const candidates: RerankCandidate[] = passages.map(p => ({
        id:   p.id,
        text: p.text,
    }));

    try {
        const ranked = await reranker.rerank(query, candidates, { topK: finalK });

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

interface ResearchMessageOptions {
    careerHistorySection?: string;
    dsaCatalog?: string;
    projectEvidenceSection?: string;
    educationSection?: string;
    certificationsSection?: string;
    jdExtractionSummary?: string;
    roleEvidenceSection?: string;
    /** Pre-formatted JD signal block injected above KB evidence. */
    jdSignalBlock?: string;
    /** Grounded technology transferability context (A5). Injected as its own section when non-empty. */
    techTransferContext?: string;
    /** Current code-stack truth per repo (doc-vs-code drift). Injected as its own section when non-empty. */
    codeStackContext?: string;
}

/**
 * Build the user message for the Research Agent.
 *
 * Assembles the extracted JD Signal block, KB context, and structured resume
 * data into a prompt with clearly delimited sections. The raw JD is NOT included
 * (single-read contract — only jd-extractor reads the JD).
 *
 * @param kbContext - Concatenated KB passages
 * @param resumeData - Structured resume data from pipeline context (may be null)
 * @param opts - Optional named sections (career history, DSA catalog, etc.)
 * @returns Formatted user message
 */
function buildResearchMessage(
    kbContext: string,
    resumeData: StructuredResumeData | null,
    opts: ResearchMessageOptions = {},
): string {
    const {
        careerHistorySection = '',
        dsaCatalog = '',
        projectEvidenceSection = '',
        educationSection = '',
        certificationsSection = '',
        jdExtractionSummary = '',
        roleEvidenceSection = '',
        jdSignalBlock = '',
        techTransferContext = '',
        codeStackContext = '',
    } = opts;

    // Single-read contract: the matcher works from the extracted JD Signal block,
    // NOT the raw JD text — only jd-extractor reads the JD, so there is no second
    // interpretation that could diverge from the canonical skill list.
    const sections: string[] = [];

    if (jdSignalBlock) {
        sections.push(jdSignalBlock, '');
    } else if (jdExtractionSummary) {
        sections.push(jdExtractionSummary, '');
    }

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

    if (roleEvidenceSection) {
        sections.push(roleEvidenceSection, '');
    }

    if (techTransferContext) {
        sections.push(techTransferContext, '');
    }

    if (codeStackContext) {
        sections.push(codeStackContext, '');
    }

    if (careerHistorySection) {
        sections.push(careerHistorySection, '');
    }

    if (educationSection) {
        sections.push(educationSection, '');
    }
    if (certificationsSection) {
        sections.push(certificationsSection, '');
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

    sections.push('Match the candidate evidence against the given JD signal and return the JSON matching brief.');

    return sections.join('\n');
}

// =============================================================================
// AGENT EXECUTION
// =============================================================================

// =============================================================================
// STRUCTURED OUTPUT — tool schema + Zod safety-net
// =============================================================================

const STR_ARRAY = { type: 'array', items: { type: 'string' } };

/** Tool the research model is forced to call. Non-model fields (resumeData,
 *  kbContext, resumeConstraints) are injected after validation, not produced
 *  by the model. JD-signal fields (targetRole, seniority, domain,
 *  hardRequirements, etc.) are provided via jdSignal — the model only emits
 *  matching fields. */
const RESEARCH_TOOL = {
    name: 'emit_research_brief',
    description: 'Emit the structured candidate↔JD matching brief. Do NOT re-derive or invent JD requirements — assess EXACTLY the skills listed in the "JD SKILLS TO ASSESS" block, one assessment per skill.',
    inputSchema: {
        type: 'object',
        properties: {
            assessments: {
                type: 'array',
                description: 'Exactly one entry per skill in the JD SKILLS TO ASSESS list (echo the skill verbatim). Fill only the fields relevant to the chosen verdict.',
                items: {
                    type: 'object',
                    properties: {
                        skill:   { type: 'string', description: 'The JD skill being assessed — echo it verbatim from the provided list.' },
                        verdict: { type: 'string', enum: ['verified', 'partial', 'gap'], description: 'verified = clearly demonstrated; partial = related/transferable foundation; gap = not demonstrated.' },
                        // verified fields
                        sourceCitation: { type: 'string', description: '(verified) where it is demonstrated — project/role/repo.' },
                        depth:          { type: 'string', enum: ['surface', 'working', 'expert'], description: '(verified) depth of demonstrated expertise.' },
                        recency:        { type: 'string', description: '(verified) how recently used.' },
                        evidenceFiles:  { type: 'array', items: { type: 'string' }, description: '(verified/partial) backing KB file paths.' },
                        // partial fields
                        gapDescription:         { type: 'string', description: '(partial) what is missing vs the full requirement.' },
                        transferableFoundation: { type: 'string', description: '(partial) the adjacent capability that bridges the gap.' },
                        framingSuggestion:      { type: 'string', description: '(partial) how to frame it honestly in an application.' },
                        // gap fields
                        gapType:                 { type: 'string', enum: ['hard', 'soft'], description: '(gap) hard = disqualifying-class requirement; soft = nice-to-have.' },
                        impactSeverity:          { type: 'string', enum: ['blocking', 'significant', 'minor'], description: '(gap) impact on viability.' },
                        disqualifyingAssessment: { type: 'string', description: '(gap) honest assessment of whether this blocks candidacy.' },
                        transferVia: { type: 'string', description: "the evidenced sibling technology this verdict leans on, ONLY when the candidate's evidence is for a transferable sibling, not the skill itself." },
                    },
                    required: ['skill', 'verdict'],
                    additionalProperties: false,
                },
            },
            overallFitRating: { type: 'string', enum: ['STRONG FIT', 'REASONABLE FIT', 'STRETCH', 'REACH'] },
            fitSummary:        { type: 'string' },
            quantifiedEvidence: {
                type: 'array', items: { type: 'string' },
                description: 'Number-bearing sentences copied VERBATIM from KB passages cited in assessments (max 8). Never alter a value; never include a number not present in a passage.',
            },
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
            'assessments',
            'overallFitRating', 'fitSummary',
        ],
        additionalProperties: false,
    },
};

/** Runtime safety-net for the model-produced matching fields only.
 *  JD-signal fields are NOT produced by this model — they come from JdSignal. */
const ResearchModelSchema = z.object({
    assessments: z.array(z.object({
        skill: z.string(),
        verdict: z.enum(['verified', 'partial', 'gap']),
        sourceCitation: z.string().optional(),
        depth: z.enum(['surface', 'working', 'expert']).optional(),
        recency: z.string().optional(),
        evidenceFiles: z.array(z.string()).default([]),
        gapDescription: z.string().optional(),
        transferableFoundation: z.string().optional(),
        framingSuggestion: z.string().optional(),
        gapType: z.enum(['hard', 'soft']).optional(),
        impactSeverity: z.enum(['blocking', 'significant', 'minor']).optional(),
        disqualifyingAssessment: z.string().optional(),
        transferVia: z.string().optional(),
    }).strict()).default([]),
    overallFitRating: z.enum(['STRONG FIT', 'REASONABLE FIT', 'STRETCH', 'REACH']),
    fitSummary: z.string(),
    // Tolerate the matcher occasionally emitting a scalar instead of an array
    // for this NON-load-bearing field (it only seeds the number allow-set):
    // coerce a string -> [string], anything else -> [], so a structured-output
    // flake never fail-fasts the whole pipeline (observed live 2026-07-14).
    quantifiedEvidence: z.array(z.string())
        .or(z.string().transform((s) => (s.trim() ? [s] : [])))
        .catch([]),
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
 * Returns ResearchMatching — the matching half only. JD-signal fields
 * (targetRole, seniority, hardRequirements, etc.) are NOT in this result;
 * run-pipeline assembles StrategistResearchResult by merging with JdSignal.
 *
 * @param raw      - Parsed tool input (model output — matching fields only)
 * @param injected - Pipeline-owned fields not produced by the model
 */
export function validateResearchResult(
    raw: unknown,
    injected: {
        resumeData: StructuredResumeData | null;
        kbContext: string;
        resumeConstraints: string;
        /** Canonical JD skill list — the fixed universe the matcher assessed.
         *  Any skill the model failed to assess is filled as an honest gap. */
        jdSkills?: string[];
        /** Verbatim KB retrieval queries this run issued (query inspection). */
        retrievalQueries?: string[];
        /** Tech-transfer groups — resolves `transferBasis` for any assessment
         *  carrying `transferVia` (the verified-downgrade guard). */
        transferGroups?: TechTransferGroup[];
    },
): ResearchMatching {
    const validated = ResearchModelSchema.safeParse(raw);
    if (!validated.success) {
        throw new Error(
            `strategist-research: research brief failed schema validation: ${validated.error.message}`,
        );
    }
    const { assessments, ...rest } = validated.data;
    // The matcher emits one verdict per canonical JD skill; derive the legacy
    // verified/partial/gap buckets so every downstream consumer is unchanged.
    const { verifiedMatches, partialMatches, gaps } = assessmentsToMatching(
        assessments,
        injected.jdSkills ?? [],
        injected.transferGroups ?? [],
    );
    return {
        ...rest,
        verifiedMatches,
        partialMatches,
        gaps,
        resumeData: injected.resumeData,
        kbContext: injected.kbContext,
        resumeConstraints: injected.resumeConstraints,
        kbRetrievalStats: computeKbStats(injected.kbContext, MIN_COSINE),
        retrievalQueries: injected.retrievalQueries ?? [],
        // Default empty ledger — run-pipeline builds the real ledger deterministically
        // from the assembled JdSignal + this matching result and overwrites this field.
        skillEvidenceLedger: [],
    };
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
    promptId: RESEARCH_PERSONA_META.id,
    promptVersion: RESEARCH_PERSONA_META.version,
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
/**
 * The JD-signal prompt block: the already-extracted requirement summary PLUS the
 * fixed "JD SKILLS TO ASSESS" list. The matcher matches against this rather than
 * re-deriving requirements. Empty string when no JD signal is available.
 */
function buildJdSignalBlock(jdSignal: JdSignal | null, jdSkills: readonly string[]): string {
    if (!jdSignal) return '';
    const ti = jdSignal.technologyInventory;
    return [
        '## JD Signal (the SINGLE extracted read of the JD — MATCH the candidate against this; the raw JD is intentionally not provided)',
        `Target role: ${jdSignal.targetRole} · Seniority: ${jdSignal.seniority} · Domain: ${jdSignal.domain}`,
        jdSignal.companyProblem ? `The problem this role solves: ${jdSignal.companyProblem}` : '',
        `Hard requirements: ${jdSignal.hardRequirements.map(r => `${r.skill}${r.disqualifying ? ' [disqualifying]' : ''}`).join(', ') || 'none'}`,
        `Technology: languages ${ti.languages.join(', ') || 'none'} · tools ${ti.tools.join(', ') || 'none'} · methodologies ${ti.methodologies.join(', ') || 'none'} · infrastructure ${ti.infrastructure.join(', ') || 'none'} · frameworks ${ti.frameworks.join(', ') || 'none'}`,
        `Experience signals: years ${jdSignal.experienceSignals.yearsExpected} · scale ${jdSignal.experienceSignals.scaleIndicators} · leadership ${jdSignal.experienceSignals.leadershipExpectation}`,
        '',
        '## JD SKILLS TO ASSESS (emit EXACTLY one assessment per skill, echoing it verbatim — do not add, merge, split, or rename)',
        ...jdSkills.map((s, i) => `${i + 1}. ${s}`),
    ].join('\n');
}

export async function executeResearchAgent(
    ctx: StrategistPipelineContext,
    pool?: Pool,
    projectEvidenceBlock = '',
    educationBlock = '',
    jdSignal: JdSignal | null = null,
    careerEntries: CareerEntry[] | null = null,
    roleEvidenceBlock = '',
    techTransferContext = '',
    codeStackContext = '',
    retrievalPrefilter?: RetrievalPrefilter,
    certificationsBlock = '',
    transferGroups: TechTransferGroup[] = [],
): Promise<AgentResult<ResearchMatching>> {
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

    // Prefer extraction-driven queries (clean skills/tools/concepts) over raw JD
    // substrings — boilerplate-free vectors sharpen retrieval. Fall back to the
    // legacy substring queries when extraction is absent (fail-open).
    const q = jdSignal ? jdRetrievalQueries(jdSignal) : null;
    // Bind the per-run retrieval pre-filter (filter-then-rank) into every KB query.
    const rds = (query: string, max: number = MAX_KB_PASSAGES): Promise<string[]> =>
        querySingleRds(query, userId, store, max, retrievalPrefilter);
    // Named so the VERBATIM query texts persist to run metadata (query
    // inspection is a first-class artifact: "was the query reasonable?"
    // comes before "did retrieval fail?").
    const skillQuery      = q ? q.skill : jd.substring(0, full);
    const experienceQuery = q ? q.experience : `professional experience skills qualifications ${jd.substring(half)}`;
    const projectQuery    = q ? q.project : `portfolio project implementation achievements ${jd.substring(0, half)}`;
    const doraQuery       = 'DORA metrics lead time MTTR change failure rate deployment frequency outcome measurement pipeline performance';
    const [factual1, factual2, factual3, factual4] = await Promise.all([
        rds(skillQuery),        // Query 1 — skills/tech matches across the user's docs
        rds(experienceQuery),   // Query 2 — experience / work-history signal
        rds(projectQuery),      // Query 3 — JD-aware project/portfolio query
        rds(doraQuery),         // Query 4 — DORA metrics and outcome measurements (static)
    ]);

    // Support-heavy roles (customerFacing + supportOps >= threshold) ground their
    // support competencies in the candidate's career_history (e.g. AWS TSA role),
    // NOT the structurally-weak engineering doc-KB. resolveSupportBoost is pure +
    // fail-open: absent/zero dimensionMix → default limit and empty note.
    const { weight: supportWeight, careerLimit, groundingNote } = resolveSupportBoost(jdSignal?.dimensionMix);
    log('INFO', 'Career grounding boost resolved', {
        agent: 'strategist-research',
        customerSupportWeight: supportWeight,
        threshold: SUPPORT_HEAVY_THRESHOLD,
        careerLimit,
    });

    let career: string[] = [];
    const careerQuery = `work history roles responsibilities ${jd.substring(0, half)}`;
    try {
        const careerStore = RdsExperienceVectorStore.fromEnvironment();
        career = await querySingleRds(careerQuery, userId, careerStore, careerLimit);
    } catch (e) {
        log('WARN', 'career vector query failed (non-fatal)', { error: (e as Error).message });
    }
    const retrievalQueries = [skillQuery, experienceQuery, projectQuery, doraQuery, careerQuery];
    const allFactualPassages = [...factual1, ...factual2, ...factual3, ...factual4, ...career];
    const dedupedContext = deduplicatePassages(allFactualPassages);

    // Prepend the support-grounding note (empty below threshold) so the matcher
    // weights career evidence for support competencies.
    kbContext = groundingNote ? `${groundingNote}\n\n${dedupedContext}` : dedupedContext;

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

    // 4. Structured career history (citeable evidence). Prefer entries the caller
    //    already loaded (run-pipeline shares one load with the experience-facts
    //    block); fall back to loading here for standalone callers.
    let careerHistorySection = '';
    if (careerEntries) {
        careerHistorySection = formatCareerHistory(careerEntries);
    } else if (pool) {
        try {
            const loaded = await loadCareerHistory(pool, userId);
            careerHistorySection = formatCareerHistory(loaded);
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
    const jdExtractionSummary = jdSignal ? formatJdExtraction(jdSignal) : '';

    // Canonical JD skill list — the FIXED universe the matcher assesses (derived
    // once from the JD signal, identical to the ledger/ATS list). The matcher
    // emits exactly one verdict per skill; it never invents its own skill set.
    const jdSkills = jdSignal ? canonicalJdSkills(jdSignal) : [];

    // Build the JD signal block injected into the prompt so the model can
    // match against given requirements rather than re-deriving them.
    const jdSignalBlock = buildJdSignalBlock(jdSignal, jdSkills);

    const userMessage = buildResearchMessage(kbContext, resumeData, {
        careerHistorySection,
        dsaCatalog,
        projectEvidenceSection: projectEvidenceBlock,
        educationSection: educationBlock,
        certificationsSection: certificationsBlock,
        jdExtractionSummary,
        roleEvidenceSection: roleEvidenceBlock,
        jdSignalBlock,
        techTransferContext,
        codeStackContext,
    });

    // 7. Run agent
    const result = await runAgent<ResearchMatching>({
        config: RESEARCH_CONFIG,
        userMessage,
        parseResponse: (text) => {
            // text is the forced tool_use input as JSON. parseJsonResponse
            // unwraps it; validateResearchResult fails fast on any schema
            // deviation instead of papering over it with defaults.
            const raw = parseJsonResponse<unknown>(text, 'strategist-research');
            return validateResearchResult(raw, { resumeData, kbContext, resumeConstraints, jdSkills, retrievalQueries, transferGroups });
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
