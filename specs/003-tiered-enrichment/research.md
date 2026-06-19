# Research: Tiered Enrichment

**Date**: 2026-06-19 | **Feature**: 003-tiered-enrichment. All grounded in live dev data + existing code.

## D1 — Pipeline order: reorder to embed-then-enrich
- **Decision**: for the changed-chunk set, compute embeddings BEFORE running the enrichment cascade. Today enrich runs first (IngestionPipeline ~L224) then embed (~L250).
- **Rationale**: Tier 2 classifies the chunk's existing Titan vector against label vectors — it needs the embedding at classify time. The embedding is computed regardless; consuming it in enrich costs nothing extra. Tiers 0/1 are order-independent.
- **Alternatives**: a separate post-embed Tier-2 pass (more passes, more code); compute a throwaway embedding in Tier 2 (wasteful, double-embed). Reorder is cleanest.

## D2 — Tier 0 JOIN keys + canonical names
- **Decision**: `document_embeddings d` ⋈ `technology_evidence te` on `(d.user_id, d.repo_full_name, d.file_path) = (te.user_id, te.repo_full_name, te.file_path)`, mapping `te.technology_id → technology_ontology.canonical_name`, aggregated per chunk into `d.technologies` (distinct, confidence-filtered). RLS-scoped by user_id.
- **Rationale**: `technology_evidence` is file-cited + confidence-scored (17,350 rows / 1,761 files on dev); `technology_ontology` holds the canonical names. The file_path is the shared key both the chunker and the extractor use. Confidence threshold drops low-signal evidence.
- **Alternatives**: trust `raw_name` (not canonical → breaks the controlled-vocab + overlap lane); per-chunk line-range matching (te has line_start/end, chunks have ranges) — deferred; file-level is the spec's granularity and sufficient for the overlap lane.

## D3 — Tier 1 rules as migrated data (`tech_skill_map`)
- **Decision**: a numbered migration creates `tech_skill_map (tech_canonical, skill_canonical, source, confidence)`, seeded from the existing `TechnologyDerivedSkillSource` + `mapTechCategoryToSkillCategory` logic. Tier 1 reads it: a chunk's Tier-0 technologies → mapped canonical skills, subject to the per-chunk precision guard.
- **Rationale**: rules as DATA (editable without deploy, queryable, eval-able) beats hard-coded branches. The mapping logic already exists at ontology-import time; this lifts it to a runtime lookup. Migration ledger + checksums per Constitution IV.
- **Alternatives**: hard-coded map in TS (needs deploy to change, not eval-friendly); LLM to derive the mapping (defeats the zero-LLM goal).

## D4 — Tier 2 classification + threshold
- **Decision**: `SkillLabelClassifier` runs `1 - (d.embedding <=> label.embedding)` over the 209 active `skill_ontology` embedded labels; assign every canonical label above a tuned threshold (a chunk may get several). Threshold tuned by the eval (start from the resolver's 0.65, re-tune for chunk-vs-label which differs from phrase-vs-label).
- **Rationale**: reuses the chunk vector (already computed) + label vectors (migration 094) — no new model call. Multi-label (not nearest-1) because a chunk can evidence several skills.
- **Alternatives**: nearest-1 (under-tags multi-skill chunks); re-embed a chunk summary (extra cost). Threshold MUST be eval-set, not guessed (FR-007).

## D5 — Tier 3 deferred collector (submit + followup)
- **Decision**: residual chunks (post 0–2) are submitted as batched multi-chunk Bedrock jobs (reusing `BedrockBatchEnrich`), the chunk marked `enrichment_status='batch_pending'` with the job linkage in metadata, and a `run-enrich-batch-followup` cronjob collects on completion → canonicalise → write skills → flip `ok`. Sync never blocks on it.
- **Rationale**: the only async tier; mirrors the proven ontology-importer submit→followup. Chunk-metadata-as-tracking avoids a new table. Prompt caching applied ONLY here, and only if the packed taxonomy prefix clears the model's minimum (see D7).
- **Alternatives**: block-poll in the sync pod (blocks sync, fragile — rejected earlier); inline per-chunk LLM for the residue (loses the batch saving on the tail).

## D6 — Content-hash dedup cache key
- **Decision**: cache canonicalised `{skills, technologies}` keyed by `enrich:v1:<userId>:<contentHash>` in the existing redis-client; check before any tier, populate after. User-scoped to avoid cross-tenant leak (Constitution V).
- **Rationale**: identical content across repos/re-syncs computes once. Cache miss falls through to the cascade (never a correctness dependency, FR-009).
- **Alternatives**: global (non-user) key — cross-tenant leak risk; no cache — recompute duplicates (the current waste).

## D7 — Prompt caching: VERIFY, don't bank (FR-011)
- **Decision**: before claiming any caching saving, verify via the live account that Bedrock prompt caching is available for `claude-haiku-4-5` in eu-west-1 and its minimum cached-prefix size. Prior signal: a ~4,096-token minimum, and our bare system prompt is ~700 tokens → caching is a no-op unless Tier 3's prefix (system + full 209-label taxonomy + few-shot) is padded past the minimum.
- **Rationale**: Constitution III — no asserted infra savings. The Tier 0–2 call-removal savings (the bulk of the ~90%) do NOT depend on caching, so caching is upside, not a dependency.

## D9 — Tier 0 already exists (verified) — NOT a build
- **Decision**: do not build a technologies tier. The enricher's `technologies` field was decommissioned in favour of the **parallel `extract_tech`** (tech-extractor Layer 1), which writes `technology_evidence`; `stampUserEvidenceMetadata` (run every sync, `run-ingestion.ts:683`) JOINs that onto chunks as `metadata.file_tech_stack` — the field retrieval reads. Verified live: `technologies` column 0/12,236 (dead); `file_tech_stack` 4,096/12,236 (33.5%). So "Tier 0" is done; it is the **input** to Tier 1, not work.
- **Rationale**: the cost driver is SKILLS (the LLM call), never technologies (already deterministic + parallel). Tier 1 reads the existing `file_tech_stack` — no JOIN, no new column.
- **Alternatives**: populating `document_embeddings.technologies` (rejected — decommissioned, unread by retrieval).

## D8 — Tier independence + fail-safe (FR-010)
- **Decision**: env flags `ENRICH_TIER0..3` gate each tier; the cascade falls through unresolved chunks to the next enabled tier, ultimately the existing per-chunk `enrich` (today's path) if all are off/failed. Tier 0 ships first (MVP), measured, then 1, 2, 3.
- **Rationale**: independent shippability + a guaranteed correct floor. A tier regressing its eval is disabled without losing enrichment.
