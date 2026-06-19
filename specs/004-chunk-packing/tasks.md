# Tasks: Chunk-Packing for Enrichment

**Feature**: 004-chunk-packing | **Branch**: `feat/chunk-packing`
**Input**: [plan.md](./plan.md) · [spec.md](./spec.md) · [data-model.md](./data-model.md) · [contracts/packing.md](./contracts/packing.md) · [research.md](./research.md)

Tests/eval ARE requested (Constitution VI — packed-vs-per-chunk recall + attribution is the binding gate).

## Phase 1: Setup

- [ ] T001 Export the new packing symbols from `applications/shared/src/index.ts` as they land (packChunks, buildPackExtractionBody, parsePackSkills, enrichPack).
- [ ] T002 [P] Confirm the live baseline for the SCs: per-repo enrich cost (~$5.90), chunk count, system-prompt token size — record any drift in `research.md`.

## Phase 2: Foundational (blocking — the packed body + parser + packer)

- [ ] T003 [P] Pure `packChunks(items, packSize, maxChars): ChunkPack[]` in `applications/shared/src/rds/enrichment/packChunks.ts` — greedy fill ≤ packSize ∧ ≤ maxChars; over-large single item = own pack; preserves order.
- [ ] T004 [P] Unit-test `packChunks.test.ts` — packing, both bounds, over-large single, order preserved.
- [ ] T005 Extend `applications/shared/src/rds/implementations/extractionBody.ts`: `buildPackExtractionBody(items)` (shared system prompt + `=== CHUNK <key> ===` blocks + `record_extractions` keyed tool, max_tokens scaled) and `parsePackSkills(content): Map<key, rawSkills>` (keyed, missing→absent, extras ignored, dup last-wins).
- [ ] T006 [P] Unit-test the body + parser in `extractionBody.test.ts` — body reuses the system prompt + forces the array tool; parser keys correctly, drops extras, leaves missing absent (no positional mapping).

**Checkpoint**: pure packer + keyed body/parser exist, unit-green — no call site wired yet.

## Phase 3: User Story 1 — Re-enrich costs far less, same skills (P1) — MVP

**Goal**: one model call per pack; per-chunk skills unchanged. **Independent test**: calls ≈ ⌈N/packSize⌉; skills match per-chunk baseline (SC-001/003).

- [ ] T007 [US1] Add `enrichPack(items): Promise<Map<key, ChunkEnrichment>>` to `BedrockChunkEnricher.ts` — one InvokeModel with `buildPackExtractionBody`, `parsePackSkills`, canonicalise each via the existing `resolveSkills`, book ONE cost record.
- [ ] T008 [P] [US1] Unit-test `enrichPack` (mock Bedrock) — keyed result, canonicalisation applied, one cost record, transport error throws (for caller fallback).
- [ ] T009 [US1] Wire `ENRICH_PACK=1` into `applications/shared/src/rds/pipeline/IngestionPipeline.ts` enrichChunks: `packChunks` → `enrichPack`; apply present keys; record `resolvedBy`; OFF → today's per-chunk loop unchanged.

**Checkpoint**: inline packing works behind the flag; call-count drop demonstrable. NOT relied upon until the eval (Phase 6).

## Phase 4: User Story 2 — Correct per-chunk attribution (P1)

**Goal**: each chunk gets its own skills; never mis-mapped. **Independent test**: distinct-skill pack → each chunk its own; missing keys → fallback, not mis-mapped (SC-004).

- [ ] T010 [US2] In the wiring, attribute strictly by key (no positional); MISSING keys (omitted/short) collected for fallback. (Same file as T009 — sequential.)
- [ ] T011 [P] [US2] Integration test (FakeEnricher returning a partial keyed map) — present keys applied to the right chunks, missing keys fall back, zero cross-chunk leakage.

## Phase 5: User Story 3 — Opt-in, bounded, fail-safe (P2)

**Goal**: off = today; budget split; failure → per-chunk. **Independent test**: SC-005/006 + FR-005.

- [ ] T012 [US3] Fail-safe in the wiring: a whole-pack transport error OR missing keys re-enrich the affected chunks via per-chunk `enrich`; `warn` logged (never zero/mis-mapped). Applies in both `enrichChunks` and `reenrichSkippedChunks`.
- [ ] T013 [US3] Mirror the `ENRICH_PACK` path into `applications/ingestion/src/util/reenrichSkippedChunks.ts` (the deferred pass) so both enrichment loops get packing.
- [ ] T014 [P] [US3] Tests: off == per-chunk (no-op); forced pack failure → per-chunk fallback with correct skills + warning.

## Phase 6: The eval gate (P1) — spans US1–US3

- [ ] T015 Build `applications/ingestion/src/run-pack-eval.ts` — labelled sample enriched per-chunk (baseline) vs packed; report per-chunk recall + precision + attribution (every chunk got its own skills); sweep `ENRICH_PACK_SIZE`. Reuse `computeEnrichEvalMetrics`.
- [ ] T016 Run on dev as a K8s Job (ingestion image, Bedrock IRSA); record recall/precision per pack size in `eval-results.md`. GATE: recall ≥ baseline AND zero misattribution before `ENRICH_PACK` is defaulted on; pick the largest pack size that holds recall.

**Checkpoint**: packing proven recall-equivalent; cost collapses ~3–4×.

## Phase 7: Polish & Cross-Cutting

- [ ] T017 [P] Docs: the `ENRICH_PACK*` switches + the eval gate + that packing composes with the future dedup/batch levers — quickstart + Job docs.
- [ ] T018 Live cost diff (SC-002) on a repo with `ENRICH_PACK=1` vs the ~$5.90 baseline; record realised $/repo + call count. ESLint + tsc + full shared/ingestion jest green.

## Dependencies & order

- **Setup (T001–T002)** → **Foundational (T003–T006)** block everything.
- **US1 (T007–T009)** is the MVP (inline packing). **US2 (T010–T011)** depends on US1 (attribution in the same wiring). **US3 (T012–T014)** depends on US1 (fail-safe + deferred mirror).
- **Eval (T015–T016)** gates relying on US1–US3. **Polish (T017–T018)** last.

## Parallel opportunities

- T003/T004 ∥ T005/T006 (separate pure units). T008 ∥ T007 once the method exists. T011 ∥ T010; T014 ∥ T012/T013.

## MVP scope

**US1 (inline packing) + US2 (attribution) + the Phase-6 eval** is the MVP — it delivers the ~3–4× call reduction proven recall-equivalent. **US3 (deferred mirror + fail-safe)** completes coverage. Dedup cache + batch are separate follow-on features.
