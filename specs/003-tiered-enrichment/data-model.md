# Data Model: Tiered Enrichment

**Date**: 2026-06-19 | **Feature**: 003-tiered-enrichment

One new table (`tech_skill_map`, Tier 1 rules). Everything else reuses existing tables/columns + in-memory shapes. The cascade writes the SAME `document_embeddings.skills`/`technologies` columns it does today.

## New table

### `tech_skill_map` (Tier 1 rules) — migration 0NN
| Column | Type | Notes |
|---|---|---|
| `tech_canonical` | text | technology_ontology canonical name (e.g. `aws_cdk`) |
| `skill_canonical` | text | skill_ontology canonical name (e.g. `iac with cdk`) |
| `source` | text | `seed` / `curated` |
| `confidence` | real | rule strength (filterable) |
| PK | (`tech_canonical`,`skill_canonical`) | one row per mapping |

Reference data (not user-scoped). Seeded from `TechnologyDerivedSkillSource` + `mapTechCategoryToSkillCategory`. Migration ledger + checksum (Constitution IV).

## Reused (unchanged schema)
- **`technology_evidence`** — Tier 0 JOIN source: `(user_id, repo_full_name, file_path, technology_id, confidence, ...)`, 17,350 rows.
- **`technology_ontology`** — `technology_id → canonical_name` for Tier 0.
- **`skill_ontology`** — 209 active labels with `embedding vector(1024)` — Tier 2 classification targets.
- **`document_embeddings`** — the cascade reads `embedding`, `content`, `file_path`; writes `skills`, `technologies`, `metadata.enrichment_status` + (Tier 3) `metadata.batch_*`.

## In-memory shapes
- **ChunkEnrichmentInput**: `{ id, filePath, content, embedding, contentHash }` — what each tier receives.
- **TierOutcome**: `{ skills: string[], technologies: string[], resolvedBy: 'tier0'|'tier1'|'tier2'|'tier3'|'pending', residual: boolean }` — a tier's result; `residual=true` passes the chunk down-cascade. `resolvedBy` is recorded (metadata) for coverage/cost measurement (SC-002) + the eval.
- **EnrichCacheEntry**: `{ skills, technologies }` keyed by `enrich:v1:<userId>:<contentHash>` (dedup, FR-009).
- **BatchPendingLink** (Tier 3): chunk `metadata.batch_job_arn / batch_record_id / batch_run_key`, `enrichment_status='batch_pending'` — the followup's work-list.

## Invariants
- Every tier outputs ONLY canonical `skill_ontology` / `technology_ontology` terms (FR-006).
- A tier's chunk output is bounded by the chunk's own evidence (FR-008) — never the file-blanket.
- Skills/technologies columns + retrieval lanes are unchanged in shape; only HOW they're populated changes.
