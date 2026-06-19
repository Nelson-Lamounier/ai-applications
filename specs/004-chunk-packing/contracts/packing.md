# Contract: Chunk-Packing

**Date**: 2026-06-19 | **Feature**: 004-chunk-packing

Internal contracts: a pure packer + the packed body/parser + the enricher method + env switches.

## Env switches (default = today's per-chunk path)
| Var | Effect |
|---|---|
| `ENRICH_PACK=1` | enable packing in the enrichment loop |
| `ENRICH_PACK_SIZE` | max chunks per pack (default ~20) |
| `ENRICH_PACK_MAX_CHARS` | max combined content per pack (default ~24000) |
Off ⇒ behaviour + cost identical to today (FR-006/SC-005).

## `packChunks(items, packSize, maxChars): ChunkPack[]` (pure)
- Greedy fill: a pack holds ≤ `packSize` items AND ≤ `maxChars` combined content.
- A single item exceeding `maxChars` forms its own one-item pack (degrades to per-chunk for it; never dropped).
- Deterministic; preserves input order; no I/O. Unit-tested.

## `buildPackExtractionBody(items): Record<string, unknown>` (pure)
- Reuses the EXISTING enrichment system prompt; user message presents each item as a `=== CHUNK <key> ===` block.
- Forces `record_extractions` whose input is `{ extractions: [{ key, skills }] }`; `max_tokens` scaled by pack size.

## `parsePackSkills(content): Map<string, unknown[]>` (pure)
- Extracts the `record_extractions` tool_use → `key → raw skills`. Missing/duplicate/extra keys handled: extras ignored, duplicates last-wins, missing left absent (→ fallback). Never positional.

## `enricher.enrichPack(items): Promise<Map<string, ChunkEnrichment>>`
- One InvokeModel with the packed body → `parsePackSkills` → canonicalise each via the SAME `resolveSkills` cascade → `key → {skills, technologies:[]}`.
- Books ONE cost record for the call (FR-009). Throws only on transport error (caller falls the whole pack back).

## Enrichment-loop wiring (inline pipeline + deferred reenrich)
- `ENRICH_PACK=1`: `packChunks` → `enrichPack` per pack; apply present keys; **MISSING keys re-enriched per-chunk** (`enrich`) — fallback, `warn` logged (FR-004). Whole-pack transport error → entire pack per-chunk.
- Records `resolvedBy` (pack | per-chunk-fallback) for SC-001/006.

## `run-pack-eval` (the gate, FR-008)
- Labelled sample enriched per-chunk (baseline) vs packed; reports per-chunk recall + precision + attribution (every chunk got its own skills). Sweeps pack size. **Gate**: recall ≥ baseline AND zero cross-chunk misattribution before reliance.

## Invariants (FR-002/003/007)
- Canonical-only output; per-chunk content judged individually; stable-key attribution; fail-safe to per-chunk; idempotent + one cost record per call.
