# Tasks: Skill Vocabulary Expansion

**Feature**: `specs/001-skill-vocabulary-expansion/` | **Branch**: `feat/skill-vocabulary-expansion`

**Inputs**: plan.md, spec.md (US1–US3), research.md (D1–D6), data-model.md, contracts/skill-importer.md, quickstart.md

Tests are included: the project follows TDD and Constitution VI mandates the resolution eval as a gate.

**Format**: `- [ ] [TaskID] [P?] [Story?] Description with file path`

---

## Phase 1: Setup

- [X] T001 Add migration `applications/platform-rds-bootstrap/migrations/095_skill_ontology_provenance.sql`: `ADD COLUMN IF NOT EXISTS source_licence TEXT, source_url TEXT`; backfill the 75 curated seed to `source_licence='curated'`; idempotent guards (per data-model.md). (Seed-dedup SQL is T020.)
- [X] T002 [P] Add capped-fetch helper `applications/ontology-importer/src/lib/capped-fetch.ts`: `undici.request` with request+body timeout and a max-response-byte cap; throws on overrun (Constitution V).
- [ ] T003 [P] Add `applications/ontology-importer/src/categorization/skill-patterns.ts`: deterministic L1–3 pattern/override rules mapping O*NET groupings → the 15 `skill_ontology` categories.

## Phase 2: Foundational (blocks all stories)

- [X] T004 [P] Unit test `applications/ontology-importer/src/lib/capped-fetch.test.ts`: times out past deadline; rejects a body exceeding the byte cap; returns body under the cap.
- [X] T005 Create `applications/shared/src/rds/implementations/SkillOntologyWriteRepository.ts` targeting `skill_ontology`/`skill_aliases`: `findByCanonical`, `insertAutoImported(canonical, display, category, source, licence, url)`, `loadAliasMap`, `insertAliases`, `deactivateStale` — mirrors `OntologyWriteRepository` but skill tables + provenance columns.
- [X] T006 Unit test `applications/shared/src/rds/implementations/SkillOntologyWriteRepository.test.ts`: insert is idempotent (re-insert no-ops); curated rows never overwritten (FR-008); aliases attach on canonical collision.
- [X] T007 Create pure `applications/shared/src/rds/ontology/dedupeSkillCanonicals.ts`: given canonical+embedding pairs + thresholds, returns merge actions (≥auto-merge → merge; [review-floor,auto) → review; else none). No DB.
- [X] T008 [P] Unit test `applications/shared/src/rds/ontology/dedupeSkillCanonicals.test.ts`: merges ≥0.85; routes 0.70–0.85 to review; leaves <0.70; deterministic ordering.
- [X] T009 Export `SkillOntologyWriteRepository`, `dedupeSkillCanonicals` from `applications/shared/src/rds/index.ts` + `applications/shared/src/index.ts`.
- [ ] T010 Scaffold the Job entrypoint `applications/ontology-importer/src/run-skill-import.ts` (env parse per contracts/, pool, observability bootstrap, source registry, `DRY_RUN` gate) — wiring only; sources/dedup land in later phases.

## Phase 3: User Story 1 — long-tail phrases resolve to canonicals (P1) 🎯 MVP

**Goal**: a comprehensive vocabulary is imported + embedded so the resolver collapses far more phrases.
**Independent test**: run the Job, then `run-skill-resolution-eval` + a re-enrich coverage check show substantial gains over the 28-of-75 / ~534 baseline (quickstart §4–5).

- [ ] T011 [P] [US1] `applications/ontology-importer/src/sources/OnetSkillSource.ts`: fetch the O*NET CC-BY bundle via capped-fetch, parse Skills/Abilities + Technology-Skills layers into `RawImportEntry[]` with altLabels as aliases.
- [X] T012 [P] [US1] `applications/ontology-importer/src/sources/CuratedSkillSource.ts`: load the project's curated engineering-tail canonicals + aliases (the moat layer) as `RawImportEntry[]`.
- [ ] T013 [US1] Wire the import loop in `run-skill-import.ts`: for each source → capped fetch → `Categorizer` (reuse L1–3 + Bedrock Haiku batch for residual) → `SkillOntologyWriteRepository` upsert; record `ImportRunCounts` via `OntologyImportRunRepository`.
- [ ] T014 [US1] After upsert, call `backfillSkillEmbeddings` in `run-skill-import.ts` to embed new `embedding IS NULL` canonicals (no new embedding code).
- [ ] T015 [US1] Integration test `applications/ontology-importer/src/run-skill-import.test.ts` (mocked sources + pg): a fixture source yields entries → upserted + categorised + counts recorded; `DRY_RUN=1` writes nothing.

## Phase 4: User Story 2 — commercially-safe + auditable (P1)

**Goal**: every written row carries an approved licence; nothing off-allowlist is written.
**Independent test**: quickstart §1–2 — off-allowlist source rejected (dry-run), and the SC-003 audit query returns 0.

- [ ] T016 [US2] Enforce the licence allowlist in `run-skill-import.ts`: reject any source/entry whose `licence` ∉ {`CC-BY-4.0`,`curated`} before any write; log + skip (non-fatal).
- [ ] T017 [US2] Stamp `source`, `source_licence`, `source_url` on every write in `SkillOntologyWriteRepository.insertAutoImported` (provenance, FR-009).
- [ ] T018 [US2] Unit test in `run-skill-import.test.ts`: a source declaring a non-allowlist licence yields zero writes; written rows all carry an approved `source_licence`.

## Phase 5: User Story 3 — preserve curation + de-duplicate (P2)

**Goal**: the 75 curated canonicals survive; the 7 known seed duplicates merge; new near-dups auto-merge/review.
**Independent test**: quickstart §2 — all 75 curated present + active; known pairs collapsed to one canonical.

- [ ] T019 [US3] Add the explicit seed-dedup SQL to migration `095_skill_ontology_provenance.sql`: for each of the 7 known pairs, re-point aliases → kept canonical, demote the duplicate `canonical_name` to an alias, set the duplicate `is_active=false`; idempotent (`WHERE is_active`).
- [ ] T020 [US3] Wire `dedupeSkillCanonicals` into `run-skill-import.ts` post-upsert: auto-merge ≥ `DEDUP_AUTO_MERGE_THRESHOLD` via `SkillOntologyWriteRepository`; route the grey band to `OntologyReviewQueueRepository`.
- [ ] T021 [US3] Guard curation in `SkillOntologyWriteRepository`: an import MUST NOT overwrite or deactivate a `curation_level='curated'` row (FR-008); covered by a test assertion in T006.

## Phase 6: Polish & Cross-Cutting

- [ ] T022 [P] Wire the Job into delivery: add the `run-skill-import` command to the `ontology-importer` Dockerfile/build + a dev K8s Job manifest (mirror the existing `run-import` Job).
- [ ] T023 Run ESLint on all new/changed files; resolve to zero errors (Constitution I).
- [ ] T024 Run the full `shared` + `ontology-importer` jest suites green; then `run-skill-resolution-eval` on dev confirms recall holds/improves with no precision drop (SC-002, Constitution VI gate).
- [ ] T025 Execute quickstart.md §1–5 on dev (dry-run, import, re-run idempotency, eval, re-enrich coverage); record figures against the captured baseline (SC-001…SC-006).

---

## Dependencies & order

- **Setup (T001–T003)** → **Foundational (T004–T010)** → stories.
- **US1 (T011–T015)** is the MVP and depends only on Foundational. **US2 (T016–T018)** and **US3 (T019–T021)** layer onto US1's import loop (share `run-skill-import.ts`), so they follow US1 but are small.
- **Polish (T022–T025)** last; T024/T025 are the binding gates (eval + quickstart).

## Parallel opportunities

- T002, T003 parallel (Setup, different files).
- T004, T008 parallel (independent unit tests).
- T011, T012 parallel (two independent sources).

## MVP scope

**US1 (T001–T015)** delivers the headline outcome: a comprehensive, embedded vocabulary the resolver matches against. US2 (licence audit) and US3 (dedup) harden it and are required for a safe merge, but US1 alone is a demonstrable coverage jump.

## Format validation

All tasks use `- [ ] Txxx [P?] [Story?] description + file path`; story labels on US phases only; Setup/Foundational/Polish unlabelled.
