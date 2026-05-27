# Retrieval-Quality Probe — Design

**Date:** 2026-05-18
**Status:** Approved (design); pending implementation plan
**Scope:** Ingestion pipeline only. The downstream product vision (identity Mirror,
Resume-vs-Reality reconciliation, Readiness Score, etc.) is explicitly **out of
scope** and tracked as a separate future initiative. This spec delivers one
dependency of that future work: a real measurement of whether ingested
embeddings can actually be retrieved.

## Problem

Ingestion currently emits two quality signals:

- `scoreProfile` — signal-weighted profile score (README/tests/CI present, etc.).
- `computeKbQuality` — documentation-breadth proxy over the ingested chunks.

Both measure *documentation breadth*. Neither measures whether the embeddings
**answer queries** — i.e. downstream RAG retrieval accuracy. A repo can score
high on KB quality yet retrieve poorly (near-duplicate chunks, weak embeddings,
bad chunk boundaries). That gap is what this probe closes.

## Decisions (locked during brainstorming)

| Decision | Choice |
|---|---|
| Eval target | Synthetic Q&A probe |
| Ground truth | Source-chunk anchored (deterministic, no human curation) |
| Execution | Inline, end of ingest (Phase 4) |
| Sample size / K | 5 questions, top-K = 3 → Recall@3 + MRR |
| Score use | Record only — `IngestionReport` + `repo_sync_state` + Prometheus + deterministic suggestions. **Never gates ingest.** |
| Architecture | Approach A — mirror the existing `kbQuality` path |

## Architecture & Boundaries

Mirror the existing `IChunkEnricher` dependency-injection pattern.

```
IngestionPipeline(vectorStore, syncState, embedder, { enricher, retrievalProbe? })
  └─ ingestChunks(): after prune, before markComplete:
       quality   = computeKbQuality(rawChunks)            // unchanged
       retrieval = await retrievalProbe?.evaluate(...)     // NEW, best-effort
       markComplete(..., quality, retrieval)               // ONE write
```

**`shared/src/rds/quality/retrievalProbe.ts`** — owns the *contract + math*:
- `IRetrievalProbe` interface (`evaluate(args): Promise<RetrievalBreakdown>`).
- Pure helpers: `scoreRetrieval`, `buildRetrievalSuggestions`, sampling helper,
  ground-truth match helper, and the `RetrievalBreakdown` / `RetrievalResult`
  types.
- No Bedrock, no I/O in the pure helpers. Shared stays Bedrock-free (it
  already is). Pure parts are unit-testable with zero I/O, exactly like
  `computeKbQuality`.

**`ingestion/src/agents/RetrievalProbe.ts`** — concrete impl, owns *execution*:
- Question generation via Bedrock InvokeModel (forced-tool, the
  `ProfileExtractor` pattern).
- Embedding via an injected `TitanEmbeddingProvider` (the same instance the
  corpus used — apples-to-apples).
- Search via injected `IVectorStore.querySimilar`.
- Scoring by delegating to the pure helpers in shared.
- `RetrievalProbe.fromEnvironment()` factory, wired in `run-ingestion.ts`
  exactly like `BedrockChunkEnricher.fromEnvironment()`. Disable via an env
  flag (e.g. `RETRIEVAL_PROBE_DISABLED=1`).

Boundary rule: **shared owns the contract + math; the ingestion app owns the
LLM/embed/search execution.**

## Data Flow (the probe)

1. **Sample** — pick 5 chunks from `rawChunks`, stratified by `tags[0]` so the
   sample spreads across documentation areas. Exclude synthetic chunks
   (`fileType === 'commit_history'`, `tags[0] === '_commits'`) — they are not
   Q&A targets. Deterministic seed = `sha256(repoFullName)` so reruns are
   stable and tests are deterministic. If fewer than 2 eligible chunks exist,
   the probe short-circuits to `status: 'skipped_no_chunks'`.

2. **Generate** — one Bedrock `InvokeModelCommand`, forced tool
   `generate_probe_questions`, input = the sampled chunk texts (truncated to
   ~1500 chars each). Output is zod-validated:
   `{ questions: [{ sourceIndex: int, question: string }] }`. System prompt
   requires each question be answerable **only** from its own source chunk and
   carries the same untrusted-content / prompt-injection clause as
   `ProfileExtractor` rule 8. Cost recorded via
   `recordBedrockCost(pool, { pipeline: 'retrieval-probe', ... })`.

3. **Embed** — embed each generated question with the injected embedder (same
   Titan model/dimension the corpus used).

4. **Search** — `querySimilar({ userId, repoFullName, queryEmbedding, limit: 3 })`
   per question. Repo-scoped so the probe measures *this repo's* retrievability,
   not cross-repo contamination.

5. **Match (ground truth)** — a source chunk counts as hit iff some result
   matches the source chunk's `(filePath, chunkIndex)` pair. Record per-question
   rank ∈ {1,2,3} or miss, plus the top result's cosine similarity.

## Scoring & Output

```ts
interface RetrievalQuestionResult {
    readonly sourceIndex:   number;
    readonly rank:          number | null;  // 1..3, or null = miss
    readonly topSimilarity: number;         // best result cosine, [0,1]
}

interface RetrievalBreakdown {
    readonly version:           1;
    readonly status:            'ok' | 'skipped_no_chunks'
                              | 'skipped_not_configured' | 'failed';
    readonly sampled:           number;   // questions actually run (<=5)
    readonly recallAt3:         number;   // hits / sampled            [0,1]
    readonly mrr:               number;   // mean(1/rank), miss=0       [0,1]
    readonly meanTopSimilarity: number;   // avg best cosine, sanity    [0,1]
    readonly score:             number;   // 0.6*recallAt3 + 0.4*mrr, round2
    readonly perQuestion:       RetrievalQuestionResult[];
    readonly suggestions:       string[]; // deterministic, no LLM
}
```

**Final score:** `round2(0.6 * recallAt3 + 0.4 * mrr)`. Recall weighted higher
than MRR because "did the right chunk come back at all" matters more than its
exact rank within a 3-slot window. `meanTopSimilarity` is a reported sanity
signal, **not** folded into `score` (it can be high even when the wrong chunk
ranks first — keeping it separate avoids masking a recall failure).

**Suggestions** (rule-based, deterministic, no LLM call):
- `recallAt3 < 0.5` → "Chunks retrieve poorly — content may be near-duplicate
  or too generic; vary section prose so chunks are distinguishable."
- `mrr < 0.4` → "Correct chunk rarely ranks #1 — competing chunks too similar;
  split overlapping documentation by concern."
- `meanTopSimilarity < 0.5` → "Low absolute similarity — embeddings are weak
  for this content; check chunk size and that prose (not just code) is present."

**Persistence & observability:**
- New migration adds `repo_sync_state.retrieval_score NUMERIC(4,2)` and
  `retrieval_breakdown JSONB` (both nullable, back-compat with pre-probe runs —
  same nullable rationale as the kb_quality columns).
- `ISyncStateRepository.markComplete` extended with optional
  `retrievalScore?` / `retrievalBreakdown?` params; `RdsSyncStateRepository`
  upsert + row mapping updated alongside the existing kb_quality columns.
- `IngestionReport` extended with `retrievalScore?` and `retrievalBreakdown?`.
- New Prometheus histogram `ingestion_retrieval_score`, buckets
  `[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]` (mirrors
  `kbQualityScoreHist`), added to the seeded zero-series.
- `retrieval_score` added to the `ingestion.complete` structured log line.

## Error Handling — best-effort, never gates

The probe is fully optional and isolated, mirroring the enricher's "never block
ingestion" contract:

| Condition | Behaviour |
|---|---|
| Not configured (factory returns undefined / disabled) | `status: 'skipped_not_configured'`, score absent, ingest proceeds |
| < 2 eligible chunks | `status: 'skipped_no_chunks'`, score absent, ingest proceeds |
| Bedrock / embed / search throws | Caught **inside** the probe, logged, `status: 'failed'`, score absent, `ingestChunks` still **succeeds** |

The probe runs inside its own OTel span `ingestion.retrieval_probe`. A probe
failure never propagates to `ingestChunks` and never flips sync state to error.

## Testing

- **Pure (shared)** — `scoreRetrieval`, `buildRetrievalSuggestions`, sampling
  determinism (same repo name → same sample), ground-truth match on
  `(filePath, chunkIndex)`. Table-driven, zero I/O. Twin of
  `computeKbQuality.test.ts`.
- **Probe impl (ingestion)** — fake `IVectorStore` + fake question-generator:
  assert recall/MRR/score math, all skip/fail statuses, and the
  never-throws guarantee (inject a throwing search → probe returns
  `status: 'failed'`, does not throw).
- **Pipeline** — extend `IngestionPipeline.test.ts`: probe injected vs absent;
  assert `markComplete` receives the retrieval args; assert `IngestionReport`
  shape; assert a throwing probe does **not** fail `ingestChunks`.

## Out of Scope

- LLM-judge relevance / answerability scoring (deferred; anchored recall chosen).
- Golden-set regression fixtures (deferred).
- Hard/soft gating on the score (record-only by decision).
- The product-facing KB consumption vision (Mirror, Reveal, Reconciliation,
  Distillation, Direction, Readiness Score) — separate initiative; this probe
  is one of its inputs.
