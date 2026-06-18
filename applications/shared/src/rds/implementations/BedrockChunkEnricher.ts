/**
 * @format
 * BedrockChunkEnricher — IChunkEnricher backed by Claude Haiku 4.5 via Bedrock
 *
 * Extracts the two flat signals every chunk needs for resume generation:
 *   - skills:        domain capabilities the chunk evidences
 *   - technologies:  named tools / products in use
 *
 * Richer per-skill detail (level, evidence_quote) intentionally lives in
 * metadata.skill_details (future PR) — keeping the interface minimal lets us
 * ship pick #2 without coupling it to schema/prompt complexity that has not
 * yet earned its place.
 *
 * Model:
 *   anthropic.claude-haiku-4-5-20251001-v1:0
 *   Messages API (system + user). Structured output enforced via tool use:
 *   the model MUST call `record_extraction` with a typed input matching
 *   ChunkEnrichment. We never parse free-form JSON from the body.
 *
 * Cost:
 *   Haiku 4.5 ≈ $0.001 per chunk at typical chunk size (1.5k input tokens,
 *   200 output tokens). 500-chunk repo ≈ $0.50.
 */

import {
    BedrockRuntimeClient,
    InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

import type { IChunkEnricher, ChunkEnrichment } from '../interfaces/IChunkEnricher.js';
import type { RawChunk } from '../types.js';
import type { Pool } from 'pg';
import { recordBedrockCost } from '../bedrock-cost.js';

const DEFAULT_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';

const SYSTEM_PROMPT = [
    'You are a skill-evidence extractor for a resume-generation system.',
    'Given a single document chunk from a software repository, identify',
    'domain capabilities the chunk EVIDENCES the user has practised.',
    'Use short noun phrases (≤ 4 words). Examples:',
    '  "kubernetes networking", "iac with cdk", "step functions orchestration"',
    '',
    'Rules:',
    '  - Extract only signals that the chunk text actually demonstrates.',
    '    Do NOT infer from the file path, repository name, or chunk metadata.',
    '  - Generic prose ("we use kubernetes") with no specifics is awareness',
    '    only — STILL extract it. Do not gate on depth at this stage.',
    '  - Background facts about a technology (its limits, its history) are',
    '    NOT user signals. Skip them.',
    '  - Lowercased output. Deduplicate. Empty arrays are valid when no',
    '    signal is present.',
    '  - You MUST respond by calling the record_extraction tool. Do not write',
    '    free-form text.',
    '',
    // NOTE: prior to 2026-05-27 this prompt also asked for `technologies`.
    // That role moved to the deterministic tech-extractor Layer-1 pipeline
    // after the 2026-05-26 → 2026-05-27 parity work (artefact in
    // applications/tech-extractor/parity/2026-05-26-bucket-recount.md, v2.3
    // trajectory section). The enricher now extracts SKILLS ONLY.
].join('\n');

const TOOL_SCHEMA = {
    name:        'record_extraction',
    description: 'Records the extracted skills for the chunk.',
    input_schema: {
        type: 'object',
        properties: {
            skills: {
                type:        'array',
                items:       { type: 'string' },
                description: 'Domain capabilities the chunk evidences. Lowercased.',
            },
        },
        required: ['skills'],
        additionalProperties: false,
    },
};

interface AnthropicToolUseBlock {
    type:  'tool_use';
    name:  string;
    input: { skills?: unknown[] };
}

interface AnthropicTextBlock { type: 'text'; text: string }

interface AnthropicResponse {
    content: Array<AnthropicToolUseBlock | AnthropicTextBlock>;
    usage?:  { input_tokens?: number; output_tokens?: number };
}

export interface BedrockChunkEnricherConfig {
    /** Override the model ID (default: Claude Haiku 4.5). */
    readonly modelId?: string;
    /** Bedrock client region. Defaults to AWS_REGION env or us-east-1. */
    readonly region?: string;
    /**
     * Lowercased alias -> canonical skill map (from SkillOntologyRepository,
     * migration 092). When present, each emitted skill is resolved to its
     * canonical form so LLM variance ("k8s networking" ≈ "kubernetes
     * networking") collapses deterministically. Unknown skills pass through as
     * their normalised raw. Omit to keep raw skills unchanged.
     */
    readonly aliasToCanonical?: ReadonlyMap<string, string>;
}

/**
 * Per-job context for recording enrichment spend into `prompt_invocations`.
 * Mirrors {@link TitanCostContext}: without it the enricher silently invokes
 * Bedrock without booking the cost — the gap that let one repo-sync run bill
 * $8 of Haiku invisibly.
 */
export interface ChunkEnricherCostContext {
    pool:     Pool;
    userId:   string;
    repoName: string;
    // 'initial' | 'full_reindex' | 'incremental' — distinguishes an initial
    // repo ingest from a resync on the per-repo Cost breakdown (migration 082).
    syncKind?: string;
}

export class BedrockChunkEnricher implements IChunkEnricher {
    private readonly client:  BedrockRuntimeClient;
    /** Enrichment model id — exposed for chunk lineage provenance. */
    readonly modelId: string;
    private readonly costCtx?: ChunkEnricherCostContext;
    private readonly aliasToCanonical?: ReadonlyMap<string, string>;

    constructor(config: BedrockChunkEnricherConfig = {}, costCtx?: ChunkEnricherCostContext) {
        const region = config.region ?? process.env.AWS_REGION ?? 'us-east-1';
        this.client  = new BedrockRuntimeClient({ region });
        this.modelId = config.modelId ?? DEFAULT_MODEL_ID;
        this.costCtx = costCtx;
        this.aliasToCanonical = config.aliasToCanonical;
    }

    static fromEnvironment(
        costCtx?: ChunkEnricherCostContext,
        aliasToCanonical?: ReadonlyMap<string, string>,
    ): BedrockChunkEnricher {
        return new BedrockChunkEnricher({
            modelId: process.env.ENRICHMENT_MODEL_ID,
            region:  process.env.AWS_REGION,
            ...(aliasToCanonical ? { aliasToCanonical } : {}),
        }, costCtx);
    }

    // =========================================================================
    // IChunkEnricher
    // =========================================================================

    async enrich(chunk: RawChunk): Promise<ChunkEnrichment> {
        const userMessage = this.buildUserMessage(chunk);

        const body = JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens:        512,
            temperature:       0,
            system:            SYSTEM_PROMPT,
            tools:             [TOOL_SCHEMA],
            tool_choice:       { type: 'tool', name: 'record_extraction' },
            messages: [
                { role: 'user', content: userMessage },
            ],
        });

        const { body: responseBody } = await this.client.send(
            new InvokeModelCommand({
                modelId:     this.modelId,
                contentType: 'application/json',
                accept:      'application/json',
                body:        Buffer.from(body),
            }),
        );

        const parsed = JSON.parse(
            Buffer.from(responseBody).toString('utf-8'),
        ) as AnthropicResponse;

        // Book the spend BEFORE branching on tool_use — the call costs money
        // whether or not the model returned a usable extraction. Non-fatal:
        // a cost-record failure must never break ingestion.
        if (this.costCtx) {
            recordBedrockCost(this.costCtx.pool, {
                userId:       this.costCtx.userId,
                modelId:      this.modelId,
                pipeline:     'repo-sync',
                agent:        'chunk-enrich',
                inputTokens:  parsed.usage?.input_tokens  ?? 0,
                outputTokens: parsed.usage?.output_tokens ?? 0,
                repoName:     this.costCtx.repoName,
                syncKind:     this.costCtx.syncKind,
            }).catch((err) => console.warn('[BedrockChunkEnricher] cost record failed (non-fatal)', err));
        }

        const toolUse = parsed.content.find(
            (b): b is AnthropicToolUseBlock => b.type === 'tool_use',
        );

        if (!toolUse) {
            // tool_choice forces the tool — if we still get text, treat as
            // empty rather than throwing. The pipeline's failure handler will
            // mark the chunk as enrichment-failed if the caller throws.
            return { skills: [], technologies: [] };
        }

        return {
            skills:       this.normalize(toolUse.input.skills),
            // technologies extraction decommissioned 2026-05-27 — owned by
            // the deterministic tech-extractor Layer-1 pipeline. Field
            // retained as [] for schema back-compat with the existing
            // document_embeddings.technologies column.
            technologies: [],
        };
    }

    // =========================================================================
    // Private
    // =========================================================================

    /**
     * Build the user-side prompt. Includes the file path and heading so the
     * model has structural context — but the system prompt forbids inferring
     * signal from path alone.
     */
    private buildUserMessage(chunk: RawChunk): string {
        const heading = chunk.heading ?? '(no heading)';
        return [
            `File: ${chunk.filePath}`,
            `Section: ${heading}`,
            '',
            'Chunk content:',
            '"""',
            chunk.content,
            '"""',
        ].join('\n');
    }

    /**
     * Defensive normalisation of a string[] field returned by the model.
     * Lowercases, trims, deduplicates, and discards non-strings / empties.
     */
    private normalize(raw: unknown): string[] {
        if (!Array.isArray(raw)) return [];
        const seen = new Set<string>();
        for (const v of raw) {
            if (typeof v !== 'string') continue;
            const cleaned = v.toLowerCase().trim();
            if (!cleaned) continue;
            // Canonicalise against the skill ontology when available; unknown
            // skills fall through as their normalised raw. The Set dedups
            // variants that collapse to the same canonical (slice 2c).
            const canonical = this.aliasToCanonical?.get(cleaned) ?? cleaned;
            seen.add(canonical);
        }
        return Array.from(seen);
    }
}
