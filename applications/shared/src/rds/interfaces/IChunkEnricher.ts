/**
 * @format
 * IChunkEnricher — Extracts skill evidence from a raw chunk.
 *
 * The enrichment stage runs once per chunk between hash-check and embed.
 * Hash-skipped (unchanged) chunks bypass enrichment entirely — re-running
 * extraction on identical content would waste tokens and produce identical
 * results.
 *
 * Implementations can be:
 *   - LLM-backed (BedrockChunkEnricher) for production
 *   - Static / rule-based for tests
 *   - No-op for ingestion runs that opt out of enrichment
 *
 * Failure semantics:
 *   The pipeline treats enrichment as best-effort. An implementation MAY
 *   throw, but the pipeline will catch and continue with empty arrays.
 *   Returning empty arrays from a successful call (no signal found) is also
 *   valid and explicitly NOT a failure.
 */

import type { RawChunk } from '../types.js';
import type { BatchEnrichItem } from '../../bedrock/BedrockBatchEnrich.js';
import type { PackBodyItem } from '../implementations/extractionBody.js';

export interface ChunkEnrichment {
    /** Domain capabilities (e.g. "kubernetes networking"). Lowercased. */
    readonly skills: string[];
    /** Named tools/products (e.g. "calico", "traefik"). Lowercased. */
    readonly technologies: string[];
}

export interface IChunkEnricher {
    enrich(chunk: RawChunk): Promise<ChunkEnrichment>;
    /**
     * Extract skill evidence from arbitrary text (feature 002 per-file lever).
     * Optional so static/no-op test enrichers need not implement it; the
     * per-file path falls back to per-chunk `enrich` when absent.
     */
    enrichText?(filePath: string, content: string, heading?: string): Promise<ChunkEnrichment>;
    /**
     * Enrich many items in ONE Bedrock batch job (feature 002 US3, ~50%
     * cheaper). Returns canonicalised skills keyed by each item's id. Optional +
     * may throw (missing batch infra, job failure) — the pipeline falls back to
     * inline enrich, never zero-skill.
     */
    enrichBatch?(items: readonly BatchEnrichItem[], runKey: string): Promise<Map<string, ChunkEnrichment>>;
    /**
     * Enrich a PACK of chunks in ONE model call (feature 004 chunk-packing) —
     * the shared system prompt is paid once. Returns skills keyed by each item's
     * stable id. Keys absent from the response are omitted (caller re-enriches
     * them per-chunk). Optional; may throw on transport error (caller falls the
     * whole pack back to per-chunk).
     */
    enrichPack?(items: readonly PackBodyItem[]): Promise<Map<string, ChunkEnrichment>>;
}
