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
import { canonicaliseSkills } from '../ontology/canonicaliseSkills.js';
import { buildExtractionBody, buildPackExtractionBody, parsePackSkills, type PackBodyItem } from './extractionBody.js';
import { BedrockBatchEnrich, buildEnrichRecords, type BatchEnrichItem } from '../../bedrock/BedrockBatchEnrich.js';

const DEFAULT_MODEL_ID = 'anthropic.claude-haiku-4-5-20251001-v1:0';

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
    /**
     * Fuzzy fallback for skills the exact alias map misses: a phrase ->
     * canonical resolver (embedding nearest-canonical, PhraseSkillResolver).
     * Returns the canonical, or null to keep the raw phrase. Applied ONLY to
     * skills `aliasToCanonical` didn't resolve, so the cheap exact path still
     * wins. Omit to keep alias-only behaviour.
     */
    readonly resolveSkill?: (phrase: string) => Promise<string | null>;
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
    private readonly region: string;
    private readonly costCtx?: ChunkEnricherCostContext;
    private readonly aliasToCanonical?: ReadonlyMap<string, string>;
    private readonly resolveSkill?: (phrase: string) => Promise<string | null>;

    constructor(config: BedrockChunkEnricherConfig = {}, costCtx?: ChunkEnricherCostContext) {
        const region = config.region ?? process.env.AWS_REGION ?? 'us-east-1';
        this.region  = region;
        this.client  = new BedrockRuntimeClient({ region });
        this.modelId = config.modelId ?? DEFAULT_MODEL_ID;
        this.costCtx = costCtx;
        this.aliasToCanonical = config.aliasToCanonical;
        this.resolveSkill = config.resolveSkill;
    }

    static fromEnvironment(
        costCtx?: ChunkEnricherCostContext,
        aliasToCanonical?: ReadonlyMap<string, string>,
        resolveSkill?: (phrase: string) => Promise<string | null>,
    ): BedrockChunkEnricher {
        return new BedrockChunkEnricher({
            modelId: process.env.ENRICHMENT_MODEL_ID,
            region:  process.env.AWS_REGION,
            ...(aliasToCanonical ? { aliasToCanonical } : {}),
            ...(resolveSkill ? { resolveSkill } : {}),
        }, costCtx);
    }

    // =========================================================================
    // IChunkEnricher
    // =========================================================================

    async enrich(chunk: RawChunk): Promise<ChunkEnrichment> {
        return this.enrichText(chunk.filePath, chunk.content, chunk.heading);
    }

    /**
     * Extract skill evidence from arbitrary text (feature 002 cost levers).
     * The per-chunk `enrich` and the per-file path (one call per file, then fan
     * skills back to chunks by evidence) share THIS single model-call path, so
     * both bill + resolve identically — only the grouping differs.
     */
    async enrichText(filePath: string, content: string, heading?: string): Promise<ChunkEnrichment> {
        const body = JSON.stringify(buildExtractionBody(filePath, content, heading));

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
            skills:       await this.resolveSkills(toolUse.input.skills),
            // technologies extraction decommissioned 2026-05-27 — owned by
            // the deterministic tech-extractor Layer-1 pipeline. Field
            // retained as [] for schema back-compat with the existing
            // document_embeddings.technologies column.
            technologies: [],
        };
    }

    /**
     * Enrich a PACK of chunks in ONE model call (feature 004 chunk-packing).
     * Sends the chunks under the SAME system prompt (paid once, not per chunk)
     * and returns skills keyed by each chunk's stable id, canonicalised via the
     * SAME cascade as the per-chunk path. Books ONE cost record for the call.
     * Keys absent from the response are simply not in the map — the caller
     * re-enriches those chunks per-chunk (fail-safe). Throws only on transport
     * error, so the caller can fall the whole pack back.
     */
    async enrichPack(items: readonly PackBodyItem[]): Promise<Map<string, ChunkEnrichment>> {
        const body = JSON.stringify(buildPackExtractionBody(items));

        const { body: responseBody } = await this.client.send(
            new InvokeModelCommand({
                modelId:     this.modelId,
                contentType: 'application/json',
                accept:      'application/json',
                body:        Buffer.from(body),
            }),
        );

        const parsed = JSON.parse(Buffer.from(responseBody).toString('utf-8')) as AnthropicResponse;

        // ONE cost record for the packed call (FR-009) — accurate per-repo telemetry.
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

        // The packed tool_use carries `extractions` (not `skills`); the typed
        // AnthropicToolUseBlock only models the per-chunk shape, so widen here.
        const rawByKey = parsePackSkills(
            parsed.content as unknown as ReadonlyArray<{ type: string; name?: string; input?: { extractions?: unknown } }>,
        );
        const out = new Map<string, ChunkEnrichment>();
        for (const [key, raw] of rawByKey) {
            out.set(key, { skills: await this.resolveSkills(raw), technologies: [] });
        }
        return out;
    }

    /**
     * Enrich many items in ONE Bedrock batch job (feature 002 US3). Reuses the
     * SHARED extraction body (so a batched call == an inline one) and the SAME
     * canonicalisation cascade, then keys canonicalised skills by the caller's
     * item id (a chunk id for the per-chunk lever — recall-neutral). Throws when
     * batch infra is unconfigured or the job fails/expires — the pipeline falls
     * back to inline enrich (never zero-skill).
     */
    async enrichBatch(items: readonly BatchEnrichItem[], runKey: string): Promise<Map<string, ChunkEnrichment>> {
        const bucket  = process.env.ENRICH_BATCH_BUCKET;
        const roleArn = process.env.ENRICH_BATCH_ROLE_ARN;
        if (!bucket || !roleArn) {
            throw new Error('batch infra not configured (ENRICH_BATCH_BUCKET / ENRICH_BATCH_ROLE_ARN)');
        }
        const batch = new BedrockBatchEnrich({
            region:  this.region,
            bucket,
            prefix:  process.env.ENRICH_BATCH_PREFIX ?? 'enrich-batch',
            roleArn,
            modelId: this.modelId,
        });
        const { records, recordToId } = buildEnrichRecords(items);
        const jobArn = await batch.submit(records, runKey);
        await this.pollBatch(batch, jobArn);
        const rawByRecord = await batch.collect(runKey);

        const out = new Map<string, ChunkEnrichment>();
        for (const [recordId, id] of Object.entries(recordToId)) {
            const raw = rawByRecord.get(recordId) ?? [];
            out.set(id, { skills: await this.resolveSkills(raw), technologies: [] });
        }
        return out;
    }

    /** Poll a batch job to terminal state. Resolves on Completed; throws on failure/deadline. */
    private async pollBatch(batch: BedrockBatchEnrich, jobArn: string): Promise<void> {
        const deadline = Date.now() + (Number.parseInt(process.env.ENRICH_BATCH_DEADLINE_MS ?? '1200000', 10) || 1_200_000);
        const pollMs   = Number.parseInt(process.env.ENRICH_BATCH_POLL_MS ?? '30000', 10) || 30_000;
        while (Date.now() < deadline) {
            const status = await batch.status(jobArn);
            if (status === 'Completed') return;
            if (['Failed', 'Stopped', 'Expired'].includes(status)) throw new Error(`batch job ${status}`);
            await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
        throw new Error('batch job deadline exceeded');
    }

    // =========================================================================
    // Private
    // =========================================================================

    /**
     * Canonicalise the model's skills via the SHARED cascade (alias -> embedding
     * nearest-canonical -> raw). Delegates to canonicaliseSkills so the corpus
     * (write) side and the query (read) side resolve identically — the two sides
     * of `d.skills && query.skills` cannot drift.
     */
    private resolveSkills(raw: unknown): Promise<string[]> {
        return canonicaliseSkills(raw, this.aliasToCanonical, this.resolveSkill);
    }
}
