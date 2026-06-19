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
}
