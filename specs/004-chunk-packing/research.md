# Research: Chunk-Packing for Enrichment

**Date**: 2026-06-19 | **Feature**: 004-chunk-packing. Grounded in `extractionBody.ts` + the live baseline.

## D1 — Packed tool schema: `record_extractions`, keyed array
- **Decision**: extend the per-chunk `record_extraction` ({skills}) to a packed `record_extractions` whose input is `{ extractions: [{ key: string, skills: string[] }] }`. The user message presents N labelled chunks (`=== CHUNK <key> ===` blocks). `tool_choice` forces the tool.
- **Rationale**: a single forced structured call returns all chunks' skills in one shot; the `key` (not array position) carries attribution so a partial/re-ordered response still maps correctly. Reuses the EXISTING system prompt verbatim — the model's per-chunk instructions are unchanged.
- **Alternatives**: positional array (fragile if the model drops/reorders — rejected, FR-003); free-text JSON (never parsed in this codebase — rejected).

## D2 — Per-chunk key: stable, caller-supplied
- **Decision**: the key is the caller's stable chunk identifier (db id in the deferred pass; `filePath::chunkIndex` in the inline pipeline). The labelled block uses it; the parser maps `key → skills`.
- **Rationale**: attribution must survive omission/reorder; a content-independent stable key is unambiguous and lets unmatched chunks fall back.
- **Alternatives**: positional index (D1).

## D3 — Pack size + budget
- **Decision**: default pack size ~20 (`ENRICH_PACK_SIZE`), bounded by `ENRICH_PACK_MAX_CHARS` (~24,000). `packChunks` greedily fills a pack until either limit; a single chunk over the char budget forms its own pack (degrades to per-chunk for it, never dropped).
- **Rationale**: ~20 amortises the ~700-token prompt ~20× while keeping the pack well inside Haiku's context; char budget is a cheap proxy for tokens (the eval/cost run confirms the realised size). Tunable so the eval can sweep it.
- **Alternatives**: fixed 30 (less margin); token-exact counting (heavier; char proxy suffices + is bounded).

## D4 — Output budget (`max_tokens`)
- **Decision**: scale `max_tokens` with pack size (~200 output tokens/chunk × packSize, capped ~4,000). A short/truncated response is a parse failure → fallback.
- **Rationale**: each chunk needs room for its skill list; under-budgeting truncates the array (caught + fallen back, not silently lost).

## D5 — Fail-safe (FR-004)
- **Decision**: `enrichPack` returns a `Map<key, ChunkEnrichment>`; the enrich loop applies present keys and re-enriches the MISSING keys (omitted/short/malformed) via the existing per-chunk `enrich`. A whole-pack error (Bedrock/throw) falls the entire pack back to per-chunk. A `warn` is logged; never zero skills, never mis-mapped.
- **Rationale**: the per-chunk path is the always-correct floor; packing is a cost optimisation over it.

## D6 — Placement: shared enricher, both loops
- **Decision**: `enrichPack` lives on `BedrockChunkEnricher` (reuses `resolveSkills` + cost recording). Both `IngestionPipeline.enrichChunks` (inline) and `reenrichSkippedChunks` (deferred) gain a `ENRICH_PACK=1` path that builds packs and calls `enrichPack`, else today's per-chunk loop.
- **Rationale**: packing is a property of the model call, not the loop; putting it on the enricher gives both call sites the saving with one implementation.

## D7 — The eval (FR-008)
- **Decision**: `run-pack-eval` enriches a labelled sample BOTH ways (per-chunk baseline vs packed) and reports per-chunk recall + precision + an attribution check (every sampled chunk got its own, non-empty-where-expected skills). Sweeps `ENRICH_PACK_SIZE`. Gate: recall ≥ baseline, no cross-chunk misattribution, before packing is relied upon.
- **Rationale**: context-bleed is the one real risk (a chunk's skills drifting toward neighbours'); the eval measures it directly rather than assuming. Reuses the `computeEnrichEvalMetrics` scorer.

## D8 — Cost record correctness
- **Decision**: book ONE cost record per packed call (the pack's input+output tokens), tagged `chunk-enrich`, so per-repo cost telemetry stays accurate (and shows the drop). Idempotent re-runs don't double-bill (FR-009).
