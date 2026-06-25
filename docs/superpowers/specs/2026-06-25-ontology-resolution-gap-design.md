# Ontology resolution-gap control data

Date: 2026-06-25
Repo: ai-applications (ingestion + shared)
Branch: feat/ontology-resolution-gap

## Problem

Skill enrichment canonicalises free-text LLM phrases against `skill_ontology`
(exact alias → embedding nearest-canonical ≥0.65 → else keep raw). When a phrase
has no canonical (e.g. AWS service granularity: ACM, SES, Security Hub,
containerd), it is silently kept raw and never surfaces. There is **zero
telemetry** on which phrases failed to canonicalise, so the ontology cannot be
grown from real usage — the same gap affects every user, and worsens as the
product scales.

This adds an internal, admin-only control dataset capturing the phrases that did
not canonicalise, plus a ranked "what to add next" view, so the ontology can be
iterated post-launch. (Verified earlier on dev: across all users, 0/265 distinct
chunk skills are non-canonical — confirming unknowns are absorbed/dropped with no
record.)

## Scope

In scope (this PR):
1. Migration 109: `ontology_resolution_gap` append table + `ontology_gap_candidates`
   ranked view.
2. `OntologyGapRecorder` — a best-effort, never-throw sink.
3. Capture **genuine-unknown skill phrases** (resolver present, embedding match
   below threshold → kept raw) at the shared `canonicaliseSkills` cascade, wired
   from `BedrockChunkEnricher` with run context (user, repo, model, ontology
   version). Premium-enrichment path only (the deterministic free-tier-1 pass is
   canonical-by-construction, so it produces no gaps).

Deferred (documented fast-follows, same table/sink — `kind` + `method` already
model them):
- **Low-confidence folds** (`method='low_fold'`, similarity 0.65–~0.80): needs
  `PhraseSkillResolver`/`SkillEmbeddingResolver` to surface the accepted
  similarity (today `resolveByVector` returns null below threshold and only the
  canonical above it). A separate increment threads similarity out without
  changing the shared `resolveSkill` contract its evals depend on.
- **Technology path** (`kind='tech'`): instrument the technology resolver the
  same way once the skill path is proven.
- Assisted promotion into `skill_ontology`/`technology_ontology` — out of scope;
  promotion stays manual via the existing ontology-importer.

Out of scope: any user-facing surface. This is internal/admin only.

## Data model (migration 109)

```sql
CREATE TABLE IF NOT EXISTS ontology_resolution_gap (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind              TEXT NOT NULL,                 -- 'skill' | 'tech'
    raw_phrase        TEXT NOT NULL,                 -- normalised (lowercased, trimmed)
    method            TEXT NOT NULL,                 -- 'raw' (no canonical) | 'low_fold' (future)
    resolved_canonical TEXT,                         -- the fold target for low_fold; null for raw
    similarity        NUMERIC(5,4),                  -- the (rejected/low) cosine; null for raw today
    user_id           UUID,                          -- run context (nullable; best-effort)
    repo_full_name    TEXT,
    model_id          TEXT,                          -- enrichment model that emitted the phrase
    ontology_version  INTEGER,                       -- skill_ontology size/version at capture
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ontology_gap_kind_phrase ON ontology_resolution_gap (kind, raw_phrase);
CREATE INDEX IF NOT EXISTS idx_ontology_gap_created ON ontology_resolution_gap (created_at);

-- Ranked candidates: most-frequent unresolved phrases across the user base.
CREATE OR REPLACE VIEW ontology_gap_candidates AS
SELECT kind,
       raw_phrase,
       count(*)                          AS occurrences,
       count(DISTINCT user_id)           AS distinct_users,
       count(DISTINCT repo_full_name)    AS distinct_repos,
       avg(similarity)                   AS avg_similarity,   -- null until low_fold lands
       max(created_at)                   AS last_seen
FROM ontology_resolution_gap
GROUP BY kind, raw_phrase;
```

Migration runs via the numbered ledger runner (checksummed; historical
migrations immutable) per project rules.

## Components

- `applications/shared/src/rds/ontology/OntologyGapRecorder.ts` — `record(gap)`:
  one parameterised INSERT, wrapped never-throw (best-effort; a capture failure
  must never break ingestion). A no-op `NullOntologyGapRecorder` for when capture
  is disabled.
- `canonicaliseSkills(raw, aliasToCanonical?, resolveSkill?, onUnresolved?)` —
  new optional `onUnresolved(phrase)` callback, fired **only** when a resolver
  was provided **and** it returned null (genuine unknown, kept raw). Alias hits
  and successful folds never fire. The callback is synchronous + swallowed; the
  cascade's fail-safe semantics are unchanged.
- `BedrockChunkEnricher` — builds the `onUnresolved` closure binding run context
  (userId, repoName, modelId, ontologyVersion) → `recorder.record({kind:'skill',
  method:'raw', rawPhrase, ...})`. Recorder injected via config; defaults to the
  null recorder so existing callers/evals are unaffected.

## Error handling

- Recorder is best-effort: every DB error is caught + logged at debug, never
  propagated. Ingestion correctness must not depend on capture succeeding.
- `onUnresolved` is optional everywhere; omitting it = today's behaviour exactly.

## Testing

- `OntologyGapRecorder.test.ts`: records a row with the right columns (mocked
  pool); swallows a pool error without throwing.
- `canonicaliseSkills.test.ts`: `onUnresolved` fires for a genuine unknown
  (resolver returns null), and does NOT fire on an alias hit or a successful
  fold, nor when no resolver is supplied.

## Verification

- Live dev introspection confirmed the gap (0/265 non-canonical skills; AWS
  services present in chunk content but absent from the ontology).
- After deploy: `SELECT * FROM ontology_gap_candidates WHERE kind='skill' ORDER BY
  occurrences DESC` yields the ranked phrases to add to the ontology.
