# Embedding-evidence fan-back — design

**Date:** 2026-06-23
**Status:** approved (design)
**Depends on:** the per-file batching shipped in PR #337 (`reenrichSkippedChunks` + `assignSkillsToChunks`).

## Problem

The per-file enrichment lever (`ENRICH_PER_FILE=1`) in the deferred path failed
its recall gate: a live eval on `Nelson-Lamounier/ai-applications` (200 residue
chunks / 107 files) scored **recall 0.758** vs the **≥ 0.97** gate, with
`droppedSkills=200` against `addedSkills=10`.

Root cause: per-file batching extracts the **union** of a file's skills in one
call, then `assignSkillsToChunks` fans each skill back to a chunk **only when
the skill's literal term surface-matches that chunk's text** (the evidence
predicate is hard-wired to `() => false`). Skills a chunk genuinely
demonstrates but does not name verbatim are dropped — that is the ~24% gap.
Per-chunk extraction (the baseline) has no such filter: the model attaches
whatever it judges present in the chunk it is reading.

## Goal

Recover the dropped recall by adding a **semantic** evidence lane to the
fan-back: keep a skill on a chunk when its term surface-matches **OR** the
skill's vector is close enough to the chunk's vector. Use the embeddings the
system already stores — no new model calls, no new infra. Gate the result on a
fresh eval sweep before any default flip.

## Key insight (drives the design)

The deferred path enriches with `enrichTextCanonical`, so the skills it returns
are **canonical `skill_ontology` terms**, and `skill_ontology.embedding` already
holds a Titan vector for each (migration 094 + the `SkillEmbeddingResolver`
self-heal backfill). So the skill side of the cosine is a **DB lookup**, not a
Titan call. The chunk side is `document_embeddings.embedding`, already stored.
Both are Titan embeddings → same vector space → cosine is meaningful. The lane
costs nothing beyond two reads + an in-memory cosine.

## Components

### 1. `assignSkillsByEmbedding` — new shared fan-back (pure, synchronous)

Location: `applications/shared/src/rds/enrichment/assignSkillsByEmbedding.ts`,
exported from `@bedrock/shared`. Sibling to `assignSkillsToChunks` — the existing
function is **left untouched** (the inline path keeps surface-match-only for now;
it can adopt this later).

```text
assignSkillsByEmbedding(
  unit: FileEnrichUnit,
  unitSkills: readonly string[],
  opts: {
    skillVectors: Map<string, readonly number[]>;   // canonical skill -> ontology vector
    chunkVectors: Map<number, readonly number[]>;   // chunkIndex -> document_embeddings vector
    threshold: number;                              // cosine cutoff
  },
): SkillAssignment[]
```

Per chunk, keep skill `s` when
`surfaceMatch(chunk.content, s)` **OR**
`cosine(skillVectors.get(s), chunkVectors.get(chunk.chunkIndex)) >= threshold`.

- All vectors are **pre-computed by the caller** → the function stays pure and
  synchronous, mirroring `assignSkillsToChunks`'s contract.
- A skill with no `skillVectors` entry, or a chunk with no `chunkVectors` entry,
  falls back to surface-match for that pair (no embedding evidence). Never throws.
- Reuses the existing `surfaceMatch` helper and an in-memory `cosineSimilarity`
  helper (add one in `enrichment/` if none is exported).

### 2. `skill_ontology` vector lookup

A small repository method (reuse `RdsSkillOntologyRepository` /
`SkillEmbeddingResolver`'s pool) that, given a set of canonical skill names,
returns `Map<string, number[]>` from:

```sql
SELECT canonical_name, embedding
  FROM skill_ontology
 WHERE canonical_name = ANY($1) AND embedding IS NOT NULL
```

Canonical skills whose `embedding` is still NULL are simply absent from the map
→ surface-match-only for them (fail-open).

### 3. Wire the lane into the deferred per-file path

In `applications/ingestion/src/util/reenrichSkippedChunks.ts`:

- **Add `embedding` to the residue SELECT** and to `SkippedRow`. Parse the
  pgvector text (`"[0.1,0.2,...]"`) to `number[]` (a `parseVector` helper).
- In `processResiduePerFile` / `enrichUnit`, after the LLM returns a unit's
  canonical skills:
  1. Collect the unit's unique skills; look up their `skill_ontology` vectors
     (memoise in a **run-wide `Map<skill, number[]>`** so repeated skills cost a
     single lookup across the whole run).
  2. Build `chunkVectors` from the unit's residue rows' parsed embeddings.
  3. Call `assignSkillsByEmbedding(unit, skills, { skillVectors, chunkVectors,
     threshold })` instead of `assignSkillsToChunks(unit, skills, () => false)`.
- **Threshold** from `ENRICH_FANBACK_SIM_THRESHOLD` (default `0.5`; see eval).
- **Gating on availability:** the embedding lane activates only when the
  ontology-vector lookup is wired in (premium path). If the lookup is absent or
  returns nothing, the path falls back to `assignSkillsToChunks` (today's
  surface-match behaviour) — flag-off and the per-chunk path remain
  byte-for-byte unchanged.

No Titan embedder is threaded — the skill vectors come from `skill_ontology`,
the chunk vectors from the residue SELECT.

### 4. Eval sweep (the gate)

Extend `applications/ingestion/src/run-per-file-eval.ts` to **sweep thresholds**.
`PER_FILE_EVAL_THRESHOLDS` (default `0.40,0.50,0.60,0.65`). For each threshold,
build the per-file candidate using `assignSkillsByEmbedding` (loading the chunk
embeddings + the ontology skill vectors) and report `recall` + `precision` +
`callReduction` per threshold in the logged `per_file_eval.result` event.
Report-only — no DB writes. We pick the lowest threshold that reaches
**recall ≥ 0.97** with acceptable precision before any default flip.

The eval gains: the chunk embeddings in its sample SELECT, and the
`skill_ontology` vector lookup for the candidate skills.

### 5. tucaken-app #157 safety amend

On the open `feat/enrichment-premium-toggle` branch, change
`resolveEnrichmentEnv('premium')` to **drop `ENRICH_PER_FILE`** →
`{ ENRICH_TIER1: '1' }` (full per-chunk enrichment, correct quality, ~€7/repo)
until this work lands and the re-eval proves recall ≥ 0.97. Re-added in the
follow-up. One-line behavioural change + the doc comment already corrected.

## Data flow (deferred per-file path, premium)

```text
residue rows (id, file_path, chunk_index, content, content_hash,
              file_tech_stack, embedding)
   │  Tier-1 + dedup-cache pre-pass (zero-LLM)  ── resolveCheap
   ▼
residue grouped by file ── groupChunksByFile ──► FileEnrichUnit[]
   │  one enrichTextCanonical call per unit (residue-only content)
   ▼
unit canonical skills
   │  skill_ontology vector lookup (run-cached)  +  chunk vectors (from SELECT)
   ▼
assignSkillsByEmbedding(unit, skills, { skillVectors, chunkVectors, threshold })
   │  surfaceMatch OR cosine ≥ threshold
   ▼
per-chunk skills ── writeSkills + remember (unchanged)
```

## Error handling

- **Fail-open everywhere.** No ontology vector for a skill, NULL chunk
  embedding, or an empty lookup → surface-match for that pair (no regression vs
  today). The lane never blocks or throws into the enrich loop.
- A unit error still leaves its rows `pending` (no throw), as today.
- `remaining` / `onProgress` accounting unchanged from #337.

## Cost

Zero new Bedrock/embedding calls. Two extra DB reads per run (the chunk
embeddings ride the existing residue SELECT; the ontology vectors are one
batched lookup, run-cached) + in-memory cosine. Negligible.

## Testing

- `assignSkillsByEmbedding` unit tests (no DB/Bedrock): surface-only kept;
  embedding-recovers a non-surface-matching skill above threshold; below
  threshold dropped; missing skill-vector → surface-only; missing chunk-vector
  → surface-only.
- `parseVector` unit test (pgvector text → number[], NULL → null).
- `reenrichSkippedChunks` per-file test with a stub ontology-vector lookup +
  stub embeddings: a skill absent from a chunk's text but vector-close is
  recovered; flag-off / no-lookup path identical to today.
- Eval-sweep logic test (stub enricher + stub vectors): reports a row per
  threshold; recall rises as threshold falls.

## Out of scope (follow-ups)

- Flipping the `ENRICH_PER_FILE` default — done only after the eval sweep proves
  recall ≥ 0.97 on real repos, in a separate change that also re-adds
  `ENRICH_PER_FILE` to premium and sets the chosen `ENRICH_FANBACK_SIM_THRESHOLD`.
- Adopting `assignSkillsByEmbedding` in the inline `IngestionPipeline` path.
- The Bedrock Batch API lever (Option A) — the recall-neutral fallback if the
  sweep cannot reach 0.97.

## Verification (post-build, controller steps)

- Re-run the eval sweep on `ai-applications` (and one more repo) → pick the
  threshold that hits recall ≥ 0.97. If none does, per-file is not recall-safe
  and we pivot to Option A.
