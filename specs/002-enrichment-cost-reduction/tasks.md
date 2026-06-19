# Tasks: Enrichment Cost Reduction

**Feature**: 002-enrichment-cost-reduction | **Branch**: `feat/enrichment-cost-reduction`
**Input**: [plan.md](./plan.md) · [spec.md](./spec.md) · [data-model.md](./data-model.md) · [contracts/enrichment-levers.md](./contracts/enrichment-levers.md) · [research.md](./research.md)

Tests/eval ARE requested (Constitution VI — the per-file-vs-per-chunk eval is the binding merge gate).

## Phase 1: Setup

- [X] T001 Create the enrichment lever module dir `applications/shared/src/rds/enrichment/` and the bedrock helper dir `applications/shared/src/bedrock/` (if absent), and export the new symbols from `applications/shared/src/index.ts`.
- [X] T002 [P] Confirm the cost baseline for SC-002/SC-001 from the live system: distinct `file_path` count vs chunk count per repo (`document_embeddings`) and the per-chunk enrich cost-record figure; record them in `research.md` D7 if they have drifted.

## Phase 2: Foundational (blocking — both P1 stories need these)

- [X] T003 [P] Implement the pure `groupChunksByFile(chunks, maxInputChars): FileEnrichUnit[]` in `applications/shared/src/rds/enrichment/groupChunksByFile.ts` — one unit per `file_path`, chunks ordered by `chunk_index`, split a file over `maxInputChars` into ≤budget units, single-chunk file → single unit (per [data-model.md](./data-model.md)).
- [X] T004 [P] Unit-test `groupChunksByFile` in `applications/shared/src/rds/enrichment/groupChunksByFile.test.ts` — grouping, ordering, single-chunk degrade, over-budget split.
- [X] T005 [P] Implement the pure `assignSkillsToChunks(unit, unitSkills, evidence): SkillAssignment[]` in `applications/shared/src/rds/enrichment/assignSkillsToChunks.ts` — per-chunk subset by evidence (surface-match OR injected resolver-near fn); drop a unit skill no chunk evidences (FR-004); output ⊆ unit skills.
- [X] T006 [P] Unit-test `assignSkillsToChunks` in `applications/shared/src/rds/enrichment/assignSkillsToChunks.test.ts` — the precision case (file skill evidenced by only chunk A is NOT attached to chunk B), surface + resolver evidence, empty-evidence drop.
- [X] T007 Add an `enrichText(text): EnrichResult` seam to `applications/shared/src/rds/implementations/BedrockChunkEnricher.ts` (the existing per-chunk call generalised to arbitrary text) reusing the current Messages body + `resolveSkills`, so per-file and per-chunk share one model-call path.

**Checkpoint**: pure grouping + assignment + text-enrich seam exist, unit-green — neither story is wired yet.

## Phase 3: User Story 1 — Re-enrich is cheap (P1)

**Goal**: one model call per file instead of per chunk; fewer calls + lower cost.
**Independent test**: enrich a repo with `ENRICH_PER_FILE=1`; model-call count ≈ distinct-file count (SC-001).

- [X] T008 [US1] Wire the per-file path into `enrichChunks` in `applications/shared/src/rds/pipeline/IngestionPipeline.ts`: when `ENRICH_PER_FILE=1`, `groupChunksByFile` → `enrichText` per unit → `assignSkillsToChunks` → write each chunk's subset; when unset, today's per-chunk loop runs unchanged (SC-005).
- [X] T009 [US1] Emit a per-run enrich-call counter (calls, units, chunks) via the existing observability registry so SC-001 (calls ≈ files) and SC-002 (cost) are measurable from a run.
- [X] T010 [P] [US1] Integration test in `applications/shared/src/rds/pipeline/IngestionPipeline.enrichPerFile.test.ts` — `ENRICH_PER_FILE=1` makes one `enrichText` call per file (mock enricher) and writes per-chunk evidenced subsets; `unset` makes one call per chunk (no-op equivalence).

**Checkpoint**: per-file path works behind the flag; call-count drop demonstrable. NOT relied upon until Phase 4 eval is green.

## Phase 4: User Story 2 — Skills equivalent (P1) — the gate

**Goal**: prove per-file skills don't regress recall/precision vs per-chunk.
**Independent test**: run the eval; recall ≥ baseline AND precision ≥ baseline (SC-003/SC-004).

- [X] T011 [US2] Build `applications/ingestion/src/run-enrich-eval.ts` — load a labelled chunk sample, enrich per-chunk (baseline) and per-file+assign, compute per-chunk skill recall (vs baseline) + precision (added unevidenced skills), print a verdict + gate.
- [X] T012 [P] [US2] Add the labelled eval sample fixture (a set of chunks incl. a multi-purpose file where skills differ per chunk) under `applications/ingestion/src/__fixtures__/enrich-eval-sample.json` (or reuse a dev export), referenced by T011.
- [ ] T013 [US2] Run the eval on dev as a K8s Job (ingestion image, Bedrock IRSA); record recall/precision in a results note. GATE: do not enable `ENRICH_PER_FILE` in any default until recall ≥ baseline AND precision ≥ baseline.

**Checkpoint**: cost-only equivalence proven on labelled data — the cheap path is now safe to rely on.

## Phase 5: User Story 3 — Opt-in + fail-safe + batch (P2)

**Goal**: the cheapest path (batch) with a correctness fallback; gradual rollout.
**Independent test**: disable → today's path; enable + force batch failure → still correct skills via fallback (SC-006).

- [ ] T014 [US3] Port `BedrockBatchClassifier` into `applications/shared/src/bedrock/BedrockBatchEnrich.ts` — per-unit Messages bodies → S3 JSONL (size-capped) → `CreateModelInvocationJob` → poll → map `recordId`→unit; one job per run, run-scoped keys (FR-008).
- [ ] T015 [P] [US3] Unit-test `BedrockBatchEnrich` in `applications/shared/src/bedrock/BedrockBatchEnrich.test.ts` (mock S3 + Bedrock) — record building, recordId mapping, malformed-line + job-error paths.
- [ ] T016 [US3] Wire `ENRICH_BATCH=1` into `enrichChunks`: submit the (per-file or per-chunk) calls via `BedrockBatchEnrich`; on any batch error/timeout/malformed output fall back to inline `enrichText` for the affected units, `warn` log (never silent, never zero-skill) (FR-007).
- [ ] T017 [P] [US3] Integration test asserting the fallback: `ENRICH_BATCH=1` with a forced batch failure still yields correct skills for every chunk and logs the warning.

**Checkpoint**: cheapest path available; correctness guaranteed by fallback; both levers opt-in.

## Phase 6: Polish & Cross-Cutting

- [ ] T018 [P] Document the two switches + the eval gate in the re-enrich/ingestion Job docs and `quickstart.md`; note the operator runs the corpus re-enrich (roadmap #4) via the UI with these enabled.
- [ ] T019 Run a large-repo enrich on dev with `ENRICH_PER_FILE=1 ENRICH_BATCH=1` and diff the cost-record vs the per-chunk baseline; record the realised $ figure for SC-002 (measured, not asserted).
- [ ] T020 [P] ESLint + `tsc -b applications/shared applications/ingestion` clean; full shared + ingestion jest green.

## Dependencies & order

- **Setup (T001–T002)** → **Foundational (T003–T007)** block everything.
- **US1 (T008–T010)** depends on Foundational. **US2 (T011–T013)** depends on US1 (it evals the per-file path) — and is the GATE that authorises relying on US1.
- **US3 (T014–T017)** depends on Foundational (composes with US1; batch wraps whichever granularity is active). Independent of US2's verdict to BUILD, but inherits the same enable-gate.
- **Polish (T018–T020)** last.

## Parallel opportunities

- T003/T004 ∥ T005/T006 (separate pure functions + tests).
- T012 ∥ T011 setup; T015 ∥ T014 logic.
- All `[P]` tests run alongside their sibling implementation once the impl file exists.

## MVP scope

**US1 + US2** (per-file granularity proven equivalent by the eval) is the MVP — it delivers the ~3.7x call reduction safely. **US3 (batch)** is the second ~50% increment, shippable separately.
