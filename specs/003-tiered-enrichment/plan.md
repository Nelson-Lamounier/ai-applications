# Implementation Plan: Tiered Enrichment

**Branch**: `feat/tiered-enrichment` | **Date**: 2026-06-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/003-tiered-enrichment/spec.md`

## Summary

Replace the per-chunk Haiku call with a cheap-to-expensive cascade, LLM last. **Tier 0** joins the file-cited `technology_evidence` onto chunks → `document_embeddings.technologies` (zero LLM). **Tier 1** maps a chunk's file technologies/structure → canonical skills via a maintained rule table (zero LLM). **Tier 2** classifies residual chunks' existing Titan embedding against the 209 embedded `skill_ontology` labels (no new model call). **Tier 3** sends only the residue to Haiku, batched + deferred. A content-hash dedup cache (existing redis-client) sits across all tiers. Every tier emits canonical vocabulary and is eval-gated vs the per-chunk baseline.

## Technical Context

**Language/Version**: TypeScript (Node 22), yarn workspace monorepo

**Primary Dependencies**: `pg` + pgvector (Tier 0 JOIN, Tier 2 cosine), the existing `SkillEmbeddingResolver`/Titan vectors (Tier 2), `TechnologyOntologyRepository` + `technology_evidence` (Tier 0), `mapTechCategoryToSkillCategory`/`TechnologyDerivedSkillSource` (Tier 1 rule seed), the verified `BedrockBatchEnrich` (Tier 3), `applications/shared/src/cache/redis-client.ts` (dedup).

**Storage**: `document_embeddings` (skills/technologies/embedding/metadata), `technology_evidence` (17,350 rows, file-cited), `technology_ontology` (canonical tech), `skill_ontology` (209 embedded labels) + new `tech_skill_map` (Tier 1 rules). No new vector column — reuse the existing chunk embedding.

**Testing**: Jest unit tests per tier's pure logic; a **per-tier eval** (`run-enrich-eval` extended) comparing each tier's chunk skills/technologies to the per-chunk LLM baseline on a labelled sample — recall + precision, the binding gate (Constitution VI).

**Target Platform**: the ingestion pipeline (sync/resync) for Tiers 0–2 inline; a deferred collector for Tier 3.

**Project Type**: Backend enrichment re-architecture in the shared pipeline.

**Performance Goals**: ≤25% of chunks reach the LLM (SC-002); ~$5.90→~$0.40/repo (SC-001); no sync "searchable" regression (SC-006).

**Constraints**: controlled vocabulary only (FR-006); per-chunk precision guard (FR-008); per-tier eval before reliance (FR-007); fail-safe degrade to per-chunk LLM (FR-010); caching verified-not-assumed (FR-011); idempotent + content-hash dedup (FR-009).

**Pipeline-order decision (load-bearing)**: today `enrichChunks` runs BEFORE embedding. Tier 2 needs the chunk vector at classify time → **reorder to embed-then-enrich** for the changed-chunk set (the embedding is computed regardless; enrich consumes it). Tiers 0/1 don't need the vector and are order-independent. This reorder is the one structural change to the pipeline.

**Scale/Scope**: ~12k chunks / 1,761 evidenced files; four tiers, each independently shippable; Tier 0 is the MVP.

## Constitution Check

| Principle | Status | How |
|---|---|---|
| I. ESLint gate | PASS | pure tier functions ≤10 complexity; lints clean per commit. |
| II. Branch workflow | PASS | `feat/tiered-enrichment` off develop; per-tier PRs. |
| III. UK English + verified facts | PASS | every enabler measured on dev (evidence rows, label count, empty technologies). |
| IV. Migrations | PASS | `tech_skill_map` via numbered migration with the checksum ledger; idempotent. |
| V. Security & guardrails | PASS | JOIN is RLS-scoped by user_id; dedup cache key includes user scope (no cross-user leak); batch I/O bounded. |
| VI. LLM workflow + eval | PASS | **per-tier eval vs per-chunk baseline is the binding gate**; the LLM is demoted to a fallback, exactly the rule's "cheaper deterministic path first" intent. |

**No violations** → no Complexity Tracking.

## Project Structure

### Documentation (this feature)
```text
specs/003-tiered-enrichment/
- plan.md, research.md, data-model.md, quickstart.md, contracts/, tasks.md
```

### Source Code (repository root)
```text
applications/shared/src/rds/enrichment/
- tier0-technologies.ts        NEW: JOIN technology_evidence -> per-chunk canonical technologies
- tier1-skill-rules.ts         NEW pure: chunk technologies/structure -> canonical skills (rule map)
- tier2-embedding-classify.ts  NEW: chunk vector x skill_ontology label vectors -> canonical skills (threshold)
- tiered-enricher.ts           NEW: cascade orchestrator implementing IChunkEnricher (0->1->2->3 residue)

applications/shared/src/rds/implementations/
- TechSkillMapRepository.ts     NEW: load tech_skill_map (Tier 1 rules), reference data
- SkillLabelClassifier.ts       NEW: nearest-labels over skill_ontology embeddings (Tier 2), pgvector

applications/shared/src/rds/pipeline/IngestionPipeline.ts   reorder embed->enrich; call the tiered enricher
applications/shared/src/cache/enrichment-cache.ts           NEW: content-hash dedup over redis-client

applications/platform-rds-bootstrap/migrations/
- 0NN_tech_skill_map.sql        NEW: Tier 1 rule table, seeded from TechnologyDerivedSkillSource logic

applications/ingestion/src/run-enrich-eval.ts               extend: per-tier recall/precision vs per-chunk baseline
applications/ingestion/src/run-enrich-batch-followup.ts     NEW (Tier 3 only): collect the deferred LLM residue
```

**Structure Decision**: A `tiered-enricher.ts` implements the existing `IChunkEnricher` so the pipeline swaps one enricher for the cascade with no caller churn; each tier is a separate, independently-testable + independently-enable-able module (env flags `ENRICH_TIER0..3`). Tier 1 rules live in a migrated `tech_skill_map` table (seeded from the existing tech→skill logic) so they are data, not code, editable without a deploy. Tier 2 reuses the existing pgvector + Titan embeddings — no new vector column. Tier 3 reuses `BedrockBatchEnrich` + a submit/followup collector (the only async tier). The dedup cache wraps the cascade at the content-hash boundary.

## Complexity Tracking

> No Constitution violations — section intentionally empty.
