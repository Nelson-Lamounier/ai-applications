# Implementation Plan: Chunk-Packing for Enrichment

**Branch**: `feat/chunk-packing` | **Date**: 2026-06-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/004-chunk-packing/spec.md`

## Summary

Amortise the ~700-token enrichment system prompt across many chunks per Haiku call. Add a **packed extraction** body that sends N labelled chunks under one shared system prompt and forces a `record_extractions` tool returning skills **keyed per chunk**; a pure `packChunks` groups chunks into ≤budget packs; the enricher gains `enrichPack(items) → Map<key, ChunkEnrichment>` reusing the SAME canonicalisation cascade. Wired behind `ENRICH_PACK=1` into the enrichment loop with a hard fail-safe to per-chunk. Call count drops ~3–4×; skills per chunk unchanged, proven by a packed-vs-per-chunk eval.

## Technical Context

**Language/Version**: TypeScript (Node 22), yarn workspace monorepo

**Primary Dependencies**: `@aws-sdk/client-bedrock-runtime` (InvokeModel), the existing `BedrockChunkEnricher` + `extractionBody.ts` (system prompt, tool schema, parser — extended to a packed variant), the skill canonicalisation cascade (`canonicaliseSkills` / resolver), `pg`.

**Storage**: `document_embeddings` (skills written as today). No schema change.

**Testing**: Jest unit tests for the pure `packChunks` (grouping, budget split, over-large single) + the packed-body builder/parser (keying, partial/malformed); a **packed-vs-per-chunk eval** (extend `run-tier1-eval`/`run-enrich-eval` pattern) — per-chunk recall + precision + attribution, the binding gate.

**Target Platform**: the enrichment loop — both inline (`IngestionPipeline.enrichChunks`) and deferred (`reenrichSkippedChunks`); both loop per-chunk today.

**Project Type**: Backend enrichment call-shape change in the shared enricher.

**Performance Goals**: calls ≈ ⌈chunks ÷ packSize⌉ (SC-001); ~$5.90 → ~$1.50–2.00/repo (SC-002); no sync regression.

**Constraints**: cost-only + recall-preserving (FR-002, model still judges each chunk); unambiguous per-chunk attribution (FR-003); fail-safe to per-chunk (FR-004/006); pack ≤ input budget (FR-005); canonical-only via the existing cascade (FR-007); idempotent (FR-009); eval-gated (FR-008); composable with dedup+batch (FR-010).

**Pack-size decision**: default ~20 (tunable `ENRICH_PACK_SIZE`), bounded by a char/token budget (`ENRICH_PACK_MAX_CHARS`, default ~24k) and the model `max_tokens` scaled per pack (e.g. ~200 output tokens × packSize, capped). Validated by the eval, not assumed.

**Scale/Scope**: ~3,932 chunks → ~130–200 calls on the reference repo; one call-shape, opt-in, composable.

## Constitution Check

| Principle | Status | How |
|---|---|---|
| I. ESLint gate | PASS | pure `packChunks` + builder/parser ≤10 complexity; lints clean per commit. |
| II. Branch workflow | PASS | `feat/chunk-packing` off develop. |
| III. UK English + verified facts | PASS | baseline (~$5.90, 3,932 chunks, ~700-tok prompt) measured on dev. |
| V. Security & guardrails | PASS | no new data path; same RLS-scoped writes; pack bodies bounded by budget (no unbounded request). |
| VI. LLM workflow + eval | PASS | **packed-vs-per-chunk eval is the binding gate**; the change keeps one model call per unit of work better-organised (shared prompt), exactly the repo's amortise-don't-avoid principle. |

**No violations** → no Complexity Tracking.

## Project Structure

### Documentation (this feature)
```text
specs/004-chunk-packing/
- plan.md, research.md, data-model.md, quickstart.md, contracts/, tasks.md
```

### Source Code (repository root)
```text
applications/shared/src/rds/implementations/
- extractionBody.ts          extend: buildPackExtractionBody(items) + parsePackSkills(content) (record_extractions, keyed)
- BedrockChunkEnricher.ts     add enrichPack(items) -> Map<key, ChunkEnrichment> (reuse resolveSkills + cost record)

applications/shared/src/rds/enrichment/
- packChunks.ts               NEW pure: chunks -> packs (<= budget, <= packSize; over-large chunk = own pack)
- packChunks.test.ts          NEW

applications/shared/src/rds/pipeline/IngestionPipeline.ts   enrichChunks: ENRICH_PACK=1 -> pack + enrichPack, fallback per-chunk
applications/ingestion/src/util/reenrichSkippedChunks.ts    deferred pass: same packing path behind ENRICH_PACK=1

applications/ingestion/src/run-pack-eval.ts                 NEW: packed-vs-per-chunk recall/precision + attribution
```

**Structure Decision**: Keep packing inside the **shared enricher** so both the inline pipeline and the deferred re-enrich gain it by calling `enrichPack`. The packed body reuses the EXISTING system prompt + canonicalisation (only the tool schema becomes an array keyed by a stable per-chunk key), so a packed call is the per-chunk call's content under one prompt — recall-preserving by construction, attribution-safe by the key. `packChunks` is a pure, unit-tested grouping; the enrich loop tries the pack and, on any error/short response, falls back to the existing per-chunk `enrich` for the affected members (the always-correct floor).

## Complexity Tracking

> No Constitution violations — section intentionally empty.
