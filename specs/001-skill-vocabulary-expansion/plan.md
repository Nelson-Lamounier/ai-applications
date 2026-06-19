# Implementation Plan: Skill Vocabulary Expansion

**Branch**: `feat/skill-vocabulary-expansion` | **Date**: 2026-06-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-skill-vocabulary-expansion/spec.md`

## Summary

Lift the canonical skill vocabulary from a 75-row hand-seed to a comprehensive, commercially-safe set the existing embedding resolver matches against. Technical approach: a **skill-specific importer** that mirrors the proven technology ontology importer (sources → categoriser → idempotent upsert → import-run tracking), writing to `skill_ontology`/`skill_aliases` instead of the technology tables, with **source + licence provenance** recorded, near-duplicate canonicals de-duplicated, and the existing `backfillSkillEmbeddings` called to embed new canonicals so the resolver — unchanged — picks them up. No new resolution mechanism; the importer feeds the working socket.

## Technical Context

**Language/Version**: TypeScript (Node 22), yarn workspace monorepo

**Primary Dependencies**: `pg` (+ pgvector), `undici` (HTTP), `@aws-sdk/client-bedrock-runtime` (Titan embeddings for the backfill; Claude Haiku batch for residual categorisation, reusing the existing `BedrockBatchClassifier`)

**Storage**: Postgres — `skill_ontology` + `skill_aliases` (migrations 092–094), the shared `ontology_import_runs` / `ontology_import_sources` tracking tables (036), and a new provenance/licence column set (migration 095). Embeddings in the existing `vector(1024)` column + hnsw index.

**Testing**: Jest unit tests for the new write repository, source parsers, and de-dup logic; the existing skill-resolution eval (`scoreSkillResolution` + the runner, roadmap #1) as the binding quality gate (Constitution VI).

**Target Platform**: K8s Job on the dev EKS cluster, exactly like the existing `ontology-importer` (`dist/run-skill-import.js`).

**Project Type**: Backend data-pipeline (maintenance/reference-data import job within the monorepo).

**Performance Goals**: One-off / periodic batch job, not latency-sensitive. Bounded by source acquisition + embedding low-thousands of canonicals (Titan embed ≈ tens of ms each, memoised; one-time).

**Constraints**: Idempotent + re-runnable (FR-005); **capped network** — every external fetch sets a request/body timeout and a max-response-byte cap (Constitution V, currently missing in the registry sources); migration 095 applied through the **checksum ledger**; ESLint clean (Constitution I); **commercial-licence-only sources** with auditable provenance (FR-007/009); reference data — global, no RLS/userId (not user-scoped).

**Scale/Scope**: Target low-thousands of canonicals (vs 75). Bounded to the capability + tool layers relevant to software-engineering evidence, not the full occupational taxonomy.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | How this plan satisfies it |
|---|---|---|
| I. ESLint gate | ✅ | New code lints clean before each commit; complexity kept ≤10 by mirroring the existing per-source / per-repository decomposition. |
| II. Branch workflow | ✅ | `feat/skill-vocabulary-expansion` off develop; merged + deleted per rule. |
| III. UK English + verified facts | ✅ | All prose UK English; every baseline figure (75 seed, 28-of-75, ~534 taggings, 0.62) is measured on the live dev DB, not asserted. |
| V. Security & processing guardrails | ✅ | Import is transactional + idempotent (FR-005); a **new capped fetch helper** adds request/body timeout + max-byte cap to every source (closes the existing gap); migration 095 uses the checksum ledger; reference data is global (no RLS needed) — documented, not silently skipped. |
| VI. LLM / Bedrock workflow + eval | ✅ | Residual categorisation reuses the proven `Categorizer` (L1–3 deterministic, L4 Haiku batch). The **binding eval is the resolution eval** (SC-002): the vocabulary is not relied upon until recall/precision over alias positives holds vs the 75-seed baseline. |

**No violations** → Complexity Tracking section omitted.

## Project Structure

### Documentation (this feature)

```text
specs/001-skill-vocabulary-expansion/
├── plan.md              # This file
├── research.md          # Phase 0 — source + granularity decisions
├── data-model.md        # Phase 1 — entities + provenance
├── quickstart.md        # Phase 1 — run + validate guide
├── contracts/           # Phase 1 — importer Job + source-port contracts
└── tasks.md             # Phase 2 (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
applications/ontology-importer/src/
├── run-skill-import.ts                 # NEW — skill-import Job entrypoint (mirrors run-import.ts)
├── sources/
│   ├── OnetSkillSource.ts              # NEW — O*NET capability + Technology-Skills layer (CC-BY)
│   └── CuratedSkillSource.ts           # NEW — project curated tail (engineering long tail)
├── categorization/skill-patterns.ts    # NEW — skill-category rules/overrides (15 categories)
└── lib/capped-fetch.ts                 # NEW — undici fetch w/ timeout + max-byte cap (reused by all sources)

applications/shared/src/rds/
├── implementations/SkillOntologyWriteRepository.ts   # NEW — upsert/alias/dedup against skill_ontology
└── ontology/dedupeSkillCanonicals.ts                 # NEW — pure near-duplicate merge (cosine ≥ threshold)

applications/platform-rds-bootstrap/migrations/
└── 095_skill_ontology_provenance.sql   # NEW — source/licence provenance cols + import-source skill scoping
```

**Structure Decision**: Extend the existing `ontology-importer` app rather than create a new one — the importer loop, run-tracking (`OntologyImportRunRepository`), and Bedrock batch categoriser are reusable as-is. Only the **write target** (skill vs technology tables) and the **sources** are skill-specific, so those are the new units. `backfillSkillEmbeddings` (roadmap #2) is called at the end of the Job — no new embedding code.

## Complexity Tracking

> No Constitution violations — section intentionally empty.
