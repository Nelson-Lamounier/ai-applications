# Contract: Tiered Enrichment Cascade

**Date**: 2026-06-19 | **Feature**: 003-tiered-enrichment

Internal contracts: per-tier functions + the cascade orchestrator (implements `IChunkEnricher`) + env switches. No external HTTP surface.

## Env switches (default = today's per-chunk LLM path)
| Var | Effect |
|---|---|
| `ENRICH_TIER0=1` | populate technologies from technology_evidence JOIN |
| `ENRICH_TIER1=1` | deterministic skills from tech_skill_map |
| `ENRICH_TIER2=1` | embedding classification of residual skills |
| `ENRICH_TIER3=1` | batched-deferred LLM for the residue |
| `TIER2_THRESHOLD` | cosine floor (eval-tuned; default from research) |
All off ⇒ behaviour identical to today (FR-010 floor). Tiers compose; a chunk falls through unresolved tiers.

## `tier0Technologies(pool, userId, repo, chunks): Map<chunkId, string[]>`
- JOIN `technology_evidence` → canonical names per file → per chunk; confidence-filtered; RLS-scoped by user.
- Zero model calls. Distinct canonical technologies. Empty for files without evidence (no hallucination, FR-001).

## `tier1SkillRules(chunkTechs, structureSignals, ruleMap): string[]` (pure)
- For a chunk's Tier-0 technologies/structure, return mapped canonical skills from `tech_skill_map`, subject to the per-chunk evidence guard (FR-008): only skills the chunk's own content/structure supports.
- Zero model calls. Output ⊆ canonical vocabulary. Deterministic. Unit-tested.

## `tier2Classify(chunkEmbedding, labelEmbeddings, threshold): string[]`
- Cosine the chunk vector against the 209 label vectors; return every canonical label above `threshold`.
- No new model call (reuses chunk + label embeddings). Multi-label. Threshold eval-tuned (FR-007).

## `tieredEnricher.enrich(chunk)` (orchestrator, implements IChunkEnricher)
- Cache check (`enrich:v1:<userId>:<contentHash>`) → hit returns cached (FR-009).
- Else cascade: Tier 0 technologies; Tier 1 skills; residual → Tier 2; still residual → mark for Tier 3 (deferred) or, if Tier 3 off, the existing per-chunk `enrich` (floor).
- Records `resolvedBy` per chunk (coverage/cost, SC-002). Writes only canonical terms (FR-006). Populates the cache.

## `run-enrich-batch-followup` (Tier 3 only)
- Collect `batch_pending` chunks → group by job → if `Completed`, read S3, canonicalise, write skills, flip `ok`; if `Failed`, flip `skipped_quota` (retry). Sync never waits (FR-005).

## `run-enrich-eval` (extended — the per-tier gate, FR-007)
- For a labelled sample, compare EACH enabled tier's chunk skills/technologies to the per-chunk LLM baseline: recall + precision + `resolvedBy` coverage.
- **Merge gate per tier**: recall ≥ baseline, precision not below baseline, before that tier is relied upon.

## Invariants (FR-006/008/010)
- Canonical-only output; per-chunk evidence bound; fail-safe floor to today's enrichment; idempotent + dedup-cached.
