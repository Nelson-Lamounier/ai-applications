<!-- @format -->

# Filter-then-Rank Retrieval + Structural Evidence Gates — Design Spec

**Status:** proposed (for review before implementation).

## Problem

Retrieval is pure vector today: `RdsVectorStore.querySimilar` runs HNSW cosine
`WHERE user_id = $2` (+ optional repo), with a hybrid HNSW+BM25 variant — **no
structured pre-filter**. Measured failure mode (run `f10c74c0` provenance): 47
passages retrieved, **~79% never cited**, median cosine **0.291**, with generic
files (`metrics.ts`, `composition-root.md`) ranking near the top. Pure cosine over
the whole KB surfaces semantically-near-but-irrelevant chunks; the cross-encoder
rerank can't fix it (it re-scores an already-polluted candidate set).

Separately, retrieval has no notion of **authorship trust** — a fork's or a
low-confidence repo's chunks can be retrieved and presented as authored evidence.

## Goal

Make JD-matching **filter-then-rank** over three lanes, and make the "verified"
guarantee **structural** (gate unauthored / low-trust evidence at retrieval, not
just downstream).

```
Lane 1 (facts):  repo_profile + technology_evidence + evidence_topology  → exact SQL ("has Kafka?")
Lane 2 (tags):   document_embeddings.skills[] (+ denormalised repo tech)  → array overlap pre-filter
Lane 3 (prose):  embedding (HNSW)                                         → cosine over SURVIVORS only
```

## Live-data constraints (verified)

- `document_embeddings.skills[]` is **87% populated** (8,039 / 9,264) — usable today.
- `document_embeddings.technologies[]` is **EMPTY (0 rows)** — deprecated to
  `technology_evidence`. ⇒ a chunk-level tech filter needs **denormalised repo
  tech**, not the dead `technologies[]` column.
- `repository_profiles.classification` exists (`fork/tutorial/stale/noise/project`)
  but all current repos are `'project'` (0 forks). Wire `is_fork` for the guarantee;
  it won't change current output.

## Part A — Ingestion-time metadata stamping (the data)

**Where:** the chunk writer, where chunks are already (re)written per sync
(`IngestionPipeline` enrich/persist → `RdsVectorStore.upsertMany`,
`document_embeddings.metadata`). **Stamp at ingestion only** — never via a separate
sync job (that re-creates doc-vs-code drift one layer down: the repo truth would
live in N chunk copies and go stale if the profile changes without re-ingestion).
All inputs are known at ingest time.

**Add to `metadata` JSONB (per chunk, from repo-level sources):**

| key | source | use |
|---|---|---|
| `is_fork` | `repository_profiles.classification = 'fork'` (classifyRepo.ts) | HARD gate |
| `repo_classification` | `repository_profiles.classification` | filter `noise`/`tutorial` |
| `repo_confidence` | `repository_profiles.quality_score` (0..1) | SOFT rank/floor |
| `role_inferred` | true when authorship is inferred, not git-attributed | caveat in framing |
| `repo_tech_stack` | `technology_evidence` canonicals (deterministic layers) | tech pre-filter |
| `repo_domain` | `repo_profile.repo_type` / domain | optional filter |

**Index:** `CREATE INDEX … ON document_embeddings USING gin (metadata jsonb_path_ops)`
plus the existing `skills[]` GIN, so the pre-filter is index-served.

## Part B — Filter-then-rank retrieval (the query)

Extend `QueryParams` + `querySimilar` with an optional filter, applied as SQL
`WHERE` **before** the vector `ORDER BY`:

```
WHERE d.user_id = $userId
  AND COALESCE((d.metadata->>'is_fork')::bool, false) = false          -- HARD: no fork authorship
  AND COALESCE(d.metadata->>'repo_classification','project')
        NOT IN ('noise','tutorial')                                    -- HARD: drop junk repos
  AND ( d.skills && $jdSkills                                          -- SOFT widen: skill overlap
        OR d.metadata->'repo_tech_stack' ?| $jdTechExpanded            --   OR tech overlap (see below)
        OR $filterDisabled )                                           -- fail-open: empty filter ⇒ no-op
ORDER BY d.embedding <=> $queryEmbedding                               -- vector-rank survivors
```

Then the existing cross-encoder rerank runs on the (smaller, on-topic) survivor set.

**Transfer-aware filter (critical):** `$jdTechExpanded = JD-tech ∪ transfer-group
siblings` (reuse `loadTransferGroups` + the alias map). A hard exact-tech filter
would discard the **transferable** evidence the vendor/tech-transfer machinery
exists to surface (Bedrock chunks for an OpenAI JD) and collapse career-changer
recall. The tech/skill clause is therefore a **soft widener** (OR'd, fail-open),
not a hard AND.

**Confidence is SOFT:** `repo_confidence` down-weights (a rank penalty or a low
floor), never a hard exclude. Low confidence ≠ false — demote, don't delete, same
as every guard in the drift chain.

**Hard gates:** `is_fork` and `repo_classification ∈ {noise,tutorial}` only.

## Honesty model (why this is "verified made structural")

The drift guards (vendor-provenance, code-truth, migration-reframe) are **curative**
— they catch mis-attribution after the agent already saw the evidence. Gating
fork / junk chunks at retrieval is **preventive**: the agent never sees unauthored
code as authored evidence. `role_inferred` flows to the strategist so an inferred
contribution is framed honestly ("contributed to", not "built").

## Build sequence

1. **Increment 1 — metadata stamping (low risk, no retrieval change).** Stamp
   `is_fork`/`repo_classification`/`repo_confidence`/`role_inferred`/`repo_tech_stack`
   into chunk metadata at ingestion + the GIN index (migration). Folds into the
   resync. Data ready, retrieval unchanged.
2. **Increment 2 — filter-then-rank (hot-path, carefully tested).** Add the filter
   to `QueryParams`/`querySimilar`, wire JD-tech-expanded + skills into
   `research-agent.querySingleRds`. Fail-open: empty filter ⇒ today's behaviour.
   Measure dead-KB % before/after via `evidence_provenance` (we already have it).
3. **Increment 3 — role_inferred framing** in the strategist (caveat low-trust).

## Tests

- Stamping: a fork repo's chunks carry `is_fork=true`; tech_stack matches
  `technology_evidence`. Pure unit on the stamp function.
- Filter SQL: fork chunks excluded; transferable (sibling-tech) chunks survive;
  empty filter ⇒ unchanged result set (fail-open).
- Regression: dead-KB % on a JD run drops (provenance), cited-evidence unchanged
  or improved.

## Risks / rollback

- Hot path: the filter is **fail-open** (empty/!provided ⇒ no WHERE addition) and
  env-gated (`RETRIEVAL_PREFILTER=on`), so it can ship dark and be toggled.
- Over-filtering recall: mitigated by the soft transfer-aware tech/skill clause +
  the provenance before/after measurement.
