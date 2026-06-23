# Per-File Batching in the Deferred Enrichment Path

- **Date:** 2026-06-23
- **Status:** Design approved, awaiting spec review
- **Repos:** ai-applications (the fix) + tucaken-app (1-line comment correction)
- **Branch:** `spec/deferred-per-file-enrichment` (ai-applications)
- **Relates to:** the enrichment-premium gating (#335 ai-applications, #157 tucaken-app)

## Problem

The premium tier sets `ENRICH_PER_FILE=1` intending ~3.7x fewer enrichment calls
(~€7 → ~€2/repo). But that lever is read in **exactly one place** —
`IngestionPipeline.ts:458`, the **inline** enrichment path — which requires an
inline enricher. The admin-api sets `DEFER_ENRICHMENT=1` for every dispatch
(`ingestion-job.ts:205`), so `run-ingestion.ts:734` passes `enricher: undefined`
inline and enrichment runs via the **deferred** path
(`runDeferredEnrichment → reenrichSkippedChunks`), which is **per-chunk** with no
per-file batching. So `ENRICH_PER_FILE=1` is currently a **no-op** for premium —
it still runs per-chunk (~€7/repo). The live `prompt_invocations` data confirms
per-chunk behaviour.

A misleading comment shipped at tucaken-app `ingestion-job.ts:21` claims
ENRICH_PER_FILE "takes precedence over DEFER_ENRICHMENT" — it does not.

## Goal

Make `ENRICH_PER_FILE` batching work in the **deferred** path so the premium cost
reduction is actually achieved, **without** dropping skill recall and **without**
re-paying for Tier-1/cache-resolved content. Reuse the proven inline machinery.

## Non-goals

- No change to the inline path (`IngestionPipeline.enrichChunksPerFile`) — unchanged.
- No pack/batch lever (`enrichPack`/`enrichBatch` have no canonical variant; the
  deferred path is canonical when `ENRICH_CANONICAL=1`).
- Do NOT flip the `ENRICH_PER_FILE` default on — it stays opt-in (premium sets it
  explicitly); the default flips only after the recall eval passes broadly.
- No migration; no change to embeddings / RAG / tech extraction / Tier-1 / dedup
  semantics (only how the *residue* LLM calls are batched).

## Verified reuse (explored, exact citations)

- `groupChunksByFile(chunks, maxInputChars): FileEnrichUnit[]` — exported from
  `@bedrock/shared` (`rds/enrichment/groupChunksByFile.ts`): groups chunks by
  `filePath`, splits a file into ≤budget units, orders by `chunkIndex`.
- `assignSkillsToChunks(unit, unitSkills, evidence): SkillAssignment[]` — exported
  (`rds/enrichment/assignSkillsToChunks.ts`): fans file-level skills back to chunks,
  keeping a skill on a chunk only if `surfaceMatch(chunkContent, skill)` (the
  evidence predicate is injectable; pass `() => false` for surface-match only).
- `enricher.enrichTextCanonical(vocabulary, filePath, content, heading)` →
  `{ canonical, newSkills }` (canonical path) and `enricher.enrichText(filePath,
  content, heading)` → `{ skills }` (free-text) — the per-unit LLM calls.
- `reenrichSkippedChunks` residue rows already carry `file_path`, `content`,
  `heading`, `content_hash`, `file_tech_stack`, ordered by `file_path, chunk_index`
  — and run the dedup-cache + Tier-1 pre-pass per chunk today.
- `computeEnrichEvalMetrics(baseline, candidate)` (`util/enrichEvalMetrics.ts`) —
  macro recall/precision; the existing tier1-eval pattern.

## Design

### 1. Residue batching in `reenrichSkippedChunks` (the core)

Refactor the per-row processing into an explicit two-phase shape:

**Phase A — cheap per-chunk pre-pass (unchanged semantics):** for every selected
row, in order: dedup-cache lookup (composite key) → Tier-1 (`tier1Skills`). A
resolved row is written immediately with **zero LLM** and `remember()`-ed. This
partitions rows into `cacheHit | tier1 | residue`.

**Phase B — residue enrichment (flag-gated on `ENRICH_PER_FILE`):**
- **`ENRICH_PER_FILE !== '1'` (default / free path):** the residue goes through
  today's **per-chunk** loop (`enrichWithLlm` — canonical or free-text) — byte-for-
  byte unchanged. (Free-tier Tier-1-only already passes no enricher, so its residue
  is simply skipped — unchanged.)
- **`ENRICH_PER_FILE === '1'` (premium):** group the residue rows by file via
  `groupChunksByFile` (adapting `SkippedRow → RawChunk` while retaining `row.id`),
  capped by `ENRICH_PER_FILE_MAX_CHARS` (12k default). For each unit, send ONLY the
  residue chunks' concatenated content in ONE call:
  - canonical (when `opts.canonicalVocab` + `enrichTextCanonical`): one
    `enrichTextCanonical(vocab, filePath, unitText, heading)`;
  - else one `enrichText(filePath, unitText, heading)`.
  Fan the returned skills back via `assignSkillsToChunks(unit, skills, () => false)`
  (surface-match guard), then `writeSkills(row.id, fanned)` + `remember()` per
  residue chunk. Bounded concurrency (existing worker pattern); telemetry logs
  `units vs residue-chunks` (~3.7x fewer calls).

The residue-only content is the key cost+correctness property: Tier-1/cache rows
are never re-sent, and the surface-match guard keeps a skill on a chunk only where
its term actually appears.

**Adapters (small, in `reenrichSkippedChunks.ts`):** add `chunk_index` to the
residue SELECT (for ordering/grouping); a `rowToChunk(row)` mapper that carries
`row.id`; a back-map from `(filePath, chunkIndex)` → `row.id` for the write-back.

### 2. Recall eval (the safety gate)

New report-only `applications/ingestion/src/run-per-file-eval.ts` (mirrors
`run-tier1-eval.ts`): for a sample of residue chunks, compute
- **baseline** = per-chunk enrichment (today's path), and
- **candidate** = per-file (group → one call/unit → `assignSkillsToChunks`),
score with `computeEnrichEvalMetrics` (recall/precision), and log. It does NOT
auto-gate. Premium uses `ENRICH_PER_FILE` **now** (explicitly set); we run this
eval on the test user's repos to confirm **recall ≥ 0.97** before flipping any
default. The `ENRICH_PER_FILE` default remains OFF.

### 3. Error handling

- A per-file unit whose LLM call throws → its residue rows are left `pending`
  (recorded as a failure), so the next sync retries them — never a silent
  zero-skill, consistent with today's per-chunk failure handling.
- `groupChunksByFile` / fan-back are pure + total; a unit with empty residue makes
  no call. Tier-1/cache pre-pass errors are already handled (fail-open) today.

### 4. tucaken-app comment correction

Fix `admin-api/src/lib/ingestion-job.ts:21` (+ the related ~:72 comment) to state
accurately that `ENRICH_PER_FILE` now batches **both** the inline and the deferred
paths (it does not "take precedence over DEFER_ENRICHMENT"; the two are
independent and the deferred path now honours the lever). Comment-only; no
behaviour change. (Small enough to land in #157 if still open, else a tiny commit.)

## Architecture / data flow (deferred path, updated)

```
SELECT residue rows (+ chunk_index), ORDER BY file_path, chunk_index
        ▼  Phase A (per-chunk, zero LLM):
   dedup-cache hit → write; else Tier-1 hit → write+remember
        ▼  residue = rows that missed both
   ENRICH_PER_FILE != 1 → per-chunk LLM loop (unchanged)
   ENRICH_PER_FILE == 1 → groupChunksByFile(residue)
                           → one enrichTextCanonical/enrichText per unit (residue text only)
                           → assignSkillsToChunks(unit, skills, surface-match)
                           → writeSkills(row.id) + remember()  per residue chunk
```

## Testing

- **Unit (`reenrichSkippedChunks.test.ts`):**
  - flag ON: residue grouped by file; ONE LLM call per file-unit (assert call count
    = unit count, not chunk count); skills fanned back only to chunks whose content
    surface-matches; Tier-1 + cache rows resolved with NO LLM (call count excludes
    them); a unit LLM error leaves its rows pending.
  - flag OFF: per-chunk path byte-for-byte unchanged (existing tests pass).
  - free path (no enricher) unchanged (existing Tier-1-only test passes).
- **Eval (`run-per-file-eval.ts`):** recall/precision per-file vs per-chunk on a
  fixture; assert recall parity (≥ 0.97 on the fixture).

## Acceptance criteria

- With `ENRICH_PER_FILE=1` on the deferred path, residue enrichment makes ONE LLM
  call per file-unit (not per chunk), and the per-run `chunk-enrich` call count
  drops materially (~3.7x) vs the per-chunk path on the same repo.
- Tier-1 + dedup-cache still resolve their chunks with zero LLM; only the residue
  is sent, residue-only content.
- Skill recall is preserved (surface-match fan-back; eval confirms ≥ 0.97).
- Flag OFF / free path: behaviour byte-for-byte unchanged. Default stays OFF.
- No migration; ESLint + typecheck clean; tests + eval green.
- The tucaken-app comment is corrected.

## Risks & mitigations

- **Recall drop from file-level extraction:** the surface-match guard bounds a
  skill to chunks where its term appears; the recall eval (≥0.97 gate) is the
  measurement before any default flip. Premium opt-in is validated on real repos
  first.
- **A huge file's residue exceeds the model budget:** `groupChunksByFile` already
  splits a file into ≤`ENRICH_PER_FILE_MAX_CHARS` units, so a big file becomes
  several units (still far fewer than per-chunk).
- **Interaction with the per-chunk dedup cache:** Phase A still writes
  `remember()` for Tier-1/cache; Phase B `remember()`s the fanned residue skills
  under the same composite key, so a later run hits the cache identically. (The
  cached skills are the fanned per-chunk result, so re-runs are consistent.)
- **A unit-level failure losing many chunks:** left `pending` for retry (not
  zero-skill); the next sync re-attempts (and could fall to per-chunk if the flag
  is later turned off). Acceptable; flagged as a possible future per-unit
  per-chunk fallback if unit failures prove common.
