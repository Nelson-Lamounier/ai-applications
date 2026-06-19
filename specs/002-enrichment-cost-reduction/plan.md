# Implementation Plan: Enrichment Cost Reduction

**Branch**: `feat/enrichment-cost-reduction` | **Date**: 2026-06-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-enrichment-cost-reduction/spec.md`

## Summary

Cut chunk-enrichment cost with two independent, opt-in levers over the existing enricher: (1) **per-file granularity** — group a file's chunks, make ONE model call per file, then assign each extracted skill down only to the chunks that evidence it (precision guard); (2) **Bedrock batch** — submit the per-file calls through the existing `BedrockBatchClassifier` pattern for the async discount. Both gated by a **per-file-vs-per-chunk eval** proving skill recall/precision don't regress (cost-only). Off by default → today's per-chunk path verbatim; any failure falls back to it.

## Technical Context

**Language/Version**: TypeScript (Node 22), yarn workspace monorepo

**Primary Dependencies**: `@aws-sdk/client-bedrock` (CreateModelInvocationJob) + `@aws-sdk/client-s3` (batch JSONL in/out) — already used by `applications/ontology-importer/src/categorization/BedrockBatchClassifier.ts`; `pg`; the existing `BedrockChunkEnricher`, the tree-sitter chunker (file/symbol boundaries already produced at ingest), and the embedding skill resolver (reused for the per-chunk evidence check).

**Storage**: `document_embeddings` (chunks carry `file_path`, `chunk_index`, `content`, `skills`); S3 for batch input/output JSONL (transient, size-capped).

**Testing**: Jest unit tests for the pure grouping + evidence-assignment functions; a per-file-vs-per-chunk **eval runner** comparing skills on a labelled sample (the binding gate, Constitution VI).

**Target Platform**: the ingestion + re-enrich K8s Jobs (background/maintenance, not the request path).

**Project Type**: Backend pipeline change inside the shared enrichment module.

**Performance Goals**: model-call count ≈ distinct-file count (≈3.7x fewer on the reference repo); a large-repo enrich cost ~$5.46 → ~$0.74.

**Constraints**: **cost-only** — skills equivalent to per-chunk within eval tolerance (FR-003); per-chunk **precision guard** (FR-004); **opt-in** (off = byte-for-byte today, FR-006); **fail-safe** to per-chunk (FR-007); idempotent + no double-bill (FR-008); batch S3 payloads bounded; resolver/vocabulary/REENRICH_ALL **unchanged** (FR-009).

**Scale/Scope**: ~12k corpus chunks / ~1,066 files on the largest repo; two levers, separately shippable.

## Constitution Check

| Principle | Status | How |
|---|---|---|
| I. ESLint gate | PASS | new pure functions kept ≤10 complexity; lints clean per commit. |
| II. Branch workflow | PASS | `feat/enrichment-cost-reduction` off develop. |
| III. UK English + verified facts | PASS | baseline figures ($5.46, 1,066 vs 3,932) measured on dev, not asserted. |
| V. Security & guardrails | PASS | batch I/O is bounded S3 JSONL (size-capped); enrichment stays idempotent + no double-bill; reference data, no RLS change. |
| VI. LLM workflow + eval | PASS | **the per-file-vs-per-chunk eval is the binding gate** — the feature is not relied upon until recall/precision show no regression. This is the central control, exactly the rule's intent. |

**No violations** → no Complexity Tracking.

## Project Structure

### Documentation (this feature)
```text
specs/002-enrichment-cost-reduction/
├── plan.md · research.md · data-model.md · quickstart.md · contracts/ · tasks.md
```

### Source Code (repository root)
```text
applications/shared/src/rds/
├── implementations/BedrockChunkEnricher.ts     # add enrichText(text) reuse seam + per-FILE entry; reuse resolveSkills
├── enrichment/groupChunksByFile.ts             # NEW pure — chunks -> per-file units (bounded by input budget)
├── enrichment/assignSkillsToChunks.ts          # NEW pure — file skills -> per-chunk by evidence (FR-004 guard)
└── pipeline/IngestionPipeline.ts               # enrichChunks: per-file path when ENRICH_PER_FILE=1, else today

applications/shared/src/bedrock/
└── BedrockBatchEnrich.ts                        # NEW — submit per-file enrich calls as a Bedrock batch
                                                 #   (port BedrockBatchClassifier: S3 JSONL + CreateModelInvocationJob + poll)

applications/ingestion/src/
└── run-enrich-eval.ts                           # NEW — per-file vs per-chunk skills on a labelled sample (FR-005 gate)
```

**Structure Decision**: Keep the levers in the **shared enrichment module** behind `BedrockChunkEnricher` so both inline ingestion and `run-reenrich` get them for free (no Job rewrite). The batch submission **ports the proven `BedrockBatchClassifier`** (already does S3 JSONL + `CreateModelInvocationJob` + polling for the technology importer) into a shared helper, not batch-from-scratch. The two pure functions (group, assign) carry the precision-sensitive logic and are unit-tested + eval-gated.

## Complexity Tracking

> No Constitution violations — section intentionally empty.
