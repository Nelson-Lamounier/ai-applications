/**
 * enrichmentMode — maps worker-layer EnrichmentMode values to the stored
 * three-value enum used in repo_sync_state.enrichment_mode.
 *
 * Stored values are exactly 'llm' | 'tier1' | 'none' so queries and
 * dashboards have a stable, narrow domain to filter on.
 */

export type StoredEnrichmentMode = 'llm' | 'tier1' | 'none';

/**
 * Convert a worker-layer EnrichmentMode string to the value persisted on
 * repo_sync_state.enrichment_mode.
 *
 * - 'premium'         → 'llm'   (Bedrock LLM enrichment active)
 * - 'free-tier1-only' → 'tier1' (deterministic Tier-1 skills only)
 * - 'disabled'        → 'none'  (no enrichment of any kind)
 */
export function normalizeEnrichmentMode(
    mode: 'premium' | 'free-tier1-only' | 'disabled',
): StoredEnrichmentMode {
    if (mode === 'premium') return 'llm';
    if (mode === 'free-tier1-only') return 'tier1';
    return 'none';
}
