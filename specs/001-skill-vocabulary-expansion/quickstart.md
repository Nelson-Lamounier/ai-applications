# Quickstart: Validate Skill Vocabulary Expansion

Proves the feature end-to-end against the Success Criteria. Run on dev.

## Prerequisites

- Migration `095` applied (provenance columns + the 7-pair seed dedup), verified through the bootstrap ledger.
- The `ontology-importer` image rebuilt with `run-skill-import.js`.
- Baseline captured **before** the import (the comparison point for SC-001):
  - `skill_ontology` row count, and `count(*) FILTER (WHERE embedding IS NOT NULL)`
  - On a reference repo, distinct skills + share of taggings landing on a canonical (current: 28-of-75 canonicals exercised, ~534 taggings on tucaken-app).

## 1. Dry run (no writes) — SC-003 licence safety + counts

Dispatch `run-skill-import` with `DRY_RUN=1`. Expect: a logged `ImportRunCounts` with non-zero `entriesFetched`, and **zero** entries whose licence is off the allowlist (rejected + logged). No DB change.

## 2. Real import + embed

Dispatch `run-skill-import` (no `DRY_RUN`). Expect exit `0`, an `ontology_import_runs` row with status `complete`, and `backfillSkillEmbeddings` having embedded the new canonicals.

Confirm via `smoke_sql`:
- `skill_ontology` count rose into the low-thousands (vs 75).
- `count(*) FILTER (WHERE embedding IS NOT NULL)` equals the active canonical count (all embedded).
- `SELECT count(*) FROM skill_ontology WHERE source_licence NOT IN ('CC-BY-4.0','curated')` → **0** (SC-003).
- All 75 original curated `canonical_name`s still present + `is_active` (SC-005).
- The known near-duplicate pairs now resolve to one canonical each (SC-006).

## 3. Re-run = no-op — SC-004 idempotency

Dispatch the same Job again. Expect: canonical count unchanged, `entriesInserted = 0`, `backfillSkillEmbeddings` embeds `0`.

## 4. Resolution eval — SC-002 (the binding gate)

Run `run-skill-resolution-eval` (roadmap #1). Expect: recall over alias positives **holds or improves** vs the 75-seed baseline, with **no** drop in precision / no new false merges. If precision regresses, the threshold is re-tuned (or the offending import batch reviewed) **before** the vocabulary is relied upon.

## 5. Re-enrich a reference repo — SC-001 coverage

Force-rebuild one repo (e.g. tucaken-app) so enrichment re-runs with the expanded vocabulary. Confirm via `smoke_sql` that the share of skill-taggings landing on a canonical, and the count of distinct canonicals exercised, **rise substantially** above the 28-of-75 / ~534-tagging baseline.

## Done when

- All of SC-001…SC-006 confirmed by the queries above, with figures recorded against the captured baseline.
