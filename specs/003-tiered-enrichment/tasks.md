# Tasks: Tiered Enrichment

**Feature**: 003-tiered-enrichment | **Branch**: `feat/tiered-enrichment`
**Input**: [plan.md](./plan.md) · [spec.md](./spec.md) · [data-model.md](./data-model.md) · [contracts/tier-cascade.md](./contracts/tier-cascade.md) · [research.md](./research.md)

Tests/eval ARE requested (Constitution VI — per-tier recall/precision vs the per-chunk baseline is the binding gate).

## Phase 1: Setup

- [ ] T001 Create `applications/shared/src/rds/enrichment/` tier modules dir (exists) + export new symbols from `applications/shared/src/index.ts` as they land.
- [ ] T002 [P] Re-confirm live baselines for the eval/SCs: per-repo enrich cost, chunk vs evidenced-file counts, `chunks.technologies` population — record any drift in `research.md`.

## Phase 2: Foundational (blocking — the cascade skeleton + reorder)

- [ ] T003 Reorder the pipeline to embed-before-enrich for the changed-chunk set in `applications/shared/src/rds/pipeline/IngestionPipeline.ts` (Tier 2 needs the vector); keep behaviour identical when no tiers are enabled.
- [ ] T004 Create `applications/shared/src/rds/enrichment/tiered-enricher.ts` implementing `IChunkEnricher` — a cascade shell that, with all tiers off, delegates to the existing per-chunk `enrich` (FR-010 floor). Records `resolvedBy` per chunk.
- [ ] T005 [P] Unit-test the cascade shell in `tiered-enricher.test.ts` — all-off == today's path; `resolvedBy` recorded; fall-through order.

**Checkpoint**: pipeline reordered, cascade shell is a verified no-op when off.

## Phase 3: Tier 0 — deterministic technologies (ALREADY EXISTS — no build)

**Finding (verified on dev):** the `technologies` column is decommissioned (0/12,236). The deterministic file→tech JOIN already runs every sync via `stampUserEvidenceMetadata` (`run-ingestion.ts:683`) → `metadata.file_tech_stack` (the field retrieval reads), live on **4,096/12,236 chunks (33.5%)**. So there is NOTHING to build here — `file_tech_stack` is the INPUT to Tier 1.

- [ ] T006 Confirm `metadata.file_tech_stack` coverage + canonical-name form on dev (one query); record as the Tier 1 input baseline. No new code, no new column.

## Phase 4: User Story 1 — Tier 1 ontology skill rules (P1) — MVP

**Goal**: deterministic SKILLS from a chunk's existing `file_tech_stack` (zero LLM) — the real cost lever (skills are the expensive LLM output). The ~33.5% of chunks with file tech can skip the LLM. **Independent test**: a chunk whose `file_tech_stack` contains a mapped tech → the mapped canonical skill, no model call; precision guard holds.

- [X] T010 [US1] Migration `0NN_tech_skill_map.sql` (ledger + checksum) creating + seeding `tech_skill_map (tech_canonical → skill_canonical)` from `TechnologyDerivedSkillSource` + `mapTechCategoryToSkillCategory`.
- [X] T011 [P] [US1] `TechSkillMapRepository.ts` to load the rule map (cached reference read).
- [X] T012 [US1] Pure `tier1-skill-rules.ts`: read a chunk's existing `metadata.file_tech_stack` (produced by the parallel `extract_tech`, canonical tech names) + rule map → canonical skills, with the per-chunk evidence guard (FR-008). No JOIN, no model call — the tech is already on the chunk.
- [X] T013 [P] [US1] Unit-test `tier1-skill-rules.test.ts` — file_tech_stack tech → mapped skill; over-tag prevented; canonical-only output; chunk with no file_tech_stack → residual.
- [X] T014 [US1] Wire Tier 1 behind `ENRICH_TIER1=1` in the cascade; residual chunks (no file_tech_stack or no rule hit) pass down-cascade; record `resolvedBy=tier1`.

## Phase 5: User Story 3 — Tier 2 embedding classification (P1)

**Goal**: residual skills via chunk-vector × label-vectors. **Independent test**: near-label chunk → canonical skill above threshold; below → residual (SC-004).

- [ ] T015 [US3] `SkillLabelClassifier.ts`: cosine chunk embedding vs the 209 `skill_ontology` label embeddings, return labels above `TIER2_THRESHOLD` (multi-label).
- [ ] T016 [P] [US3] Unit-test `SkillLabelClassifier.test.ts` (mock pgvector rows) — above-threshold assigned, below-threshold residual, multi-label.
- [ ] T017 [US3] Wire Tier 2 behind `ENRICH_TIER2=1`; still-residual chunks pass to Tier 3 (or the floor).

## Phase 6: The eval gate (P1) — spans US1–US3

- [X] T018 Extend `applications/ingestion/src/run-enrich-eval.ts` to score EACH enabled tier vs the per-chunk LLM baseline on a labelled sample: recall + precision + `resolvedBy` coverage (≤25% residual target).
- [ ] T019 Tune `TIER2_THRESHOLD` on dev via the eval; record the chosen value + per-tier recall/precision in `eval-results.md`. GATE: a tier is not relied upon until recall ≥ baseline AND precision not below.

**Checkpoint**: Tiers 0–2 proven quality-equivalent + cheap; cost already collapses (no LLM for the resolved majority).

## Phase 7: User Story 4 — Tier 3 batched + deferred residue (P2)

**Goal**: only the residue reaches the LLM, batched + async. **Independent test**: residue submitted batched; sync not blocked; residue skills land via followup (SC-006).

- [ ] T020 [US4] Submit-side: residual chunks → batched Bedrock job (reuse `BedrockBatchEnrich`), mark `enrichment_status='batch_pending'` + metadata job linkage; exit (no block-poll).
- [ ] T021 [US4] `applications/ingestion/src/run-enrich-batch-followup.ts` + dev cronjob: collect `batch_pending` → on Completed write canonical skills + flip `ok`; on Failed → `skipped_quota`.
- [ ] T022 [P] [US4] Tests: submit marks pending (no inline calls); followup collect + fail paths.
- [ ] T023 [US4] Verify Bedrock prompt-caching availability + min prefix for `claude-haiku-4-5` in eu-west-1 (live account); only then pad Tier 3's taxonomy prefix to enable caching (FR-011).

## Phase 8: Cross-cutting — controlled vocabulary + dedup cache + Polish

- [ ] T024 Content-hash dedup cache `applications/shared/src/cache/enrichment-cache.ts` over redis-client, key `enrich:v1:<userId>:<contentHash>`; check before the cascade, populate after (FR-009).
- [ ] T025 [P] Assert canonical-only output across all tiers (a cascade-level guard + test) so the `&&` overlap lane matches (FR-006/SC-005).
- [ ] T026 [P] Docs: tier switches + eval gate + the operator flow (sync/resync enables Tiers 0–2 inline; Tier 3 deferred) in quickstart + Job docs.
- [ ] T027 Live cost diff (SC-001) on a repo with all tiers on vs the ~$5.90 baseline; record realised $/repo + residual %. ESLint + tsc + full jest green.

## Dependencies & order

- **Setup (T001–T002)** → **Foundational (T003–T005)** block all tiers.
- **US1 Tier 0 (T006–T009)** is the MVP, no dependency on later tiers. **US2 Tier 1** depends on US1 (uses Tier-0 technologies). **US3 Tier 2** depends on Foundational (the reorder) + cascade. **Eval (T018–T019)** gates relying on US1–US3.
- **US4 Tier 3 (T020–T023)** depends on US1–US3 (it only sees their residue) + the verified batch infra.
- **Cross-cutting (T024–T027)** last; the dedup cache + vocab guard apply across tiers.

## Parallel opportunities

- T007 ∥ T006 done; T011 ∥ T010; T013 ∥ T012; T016 ∥ T015; T022 ∥ T020/T021.
- Tiers are independently buildable once the Foundational shell exists; US1 can ship before US2/US3 are written.

## MVP scope

**Tier 0 (technologies) already exists** — the parallel `extract_tech` stamps `file_tech_stack` each sync (33.5% of chunks); nothing to build. The MVP is **Tier 1 (skills from `file_tech_stack`)** — the first real cut to the skills LLM cost, deterministically skilling the ~33.5% of chunks that carry file tech. **Tier 1 + Tier 2** (the two zero-LLM skill tiers) deliver the bulk of the ~90%; **Tier 3** handles the irreducible LLM tail. Skills — not technologies — were always the cost.
