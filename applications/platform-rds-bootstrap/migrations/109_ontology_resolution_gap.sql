-- 109_ontology_resolution_gap.sql
--
-- Internal control dataset for growing the skill/technology ontology from real
-- usage. Skill enrichment canonicalises free-text LLM phrases against
-- skill_ontology (exact alias -> embedding nearest-canonical >= threshold ->
-- else keep raw). Phrases with no canonical are silently kept raw and never
-- surface, so the ontology cannot be iterated from what users actually have
-- (e.g. AWS service granularity: ACM, SES, Security Hub, containerd).
--
-- This append-only table records every phrase that failed to canonicalise
-- (method='raw') so the gaps are visible and rankable. Written best-effort by
-- ingestion (owner pool) and read by admins (owner pool) — not exposed to the
-- user-facing tucaken_app role. Capture is fail-open: a write failure here must
-- never break ingestion.
--
-- `method='low_fold'` (low-confidence embedding folds) + `kind='tech'` are
-- modelled now but populated by later increments.

CREATE TABLE IF NOT EXISTS ontology_resolution_gap (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    kind               TEXT        NOT NULL,              -- 'skill' | 'tech'
    raw_phrase         TEXT        NOT NULL,              -- normalised: lowercased, trimmed
    method             TEXT        NOT NULL,              -- 'raw' | 'low_fold'
    resolved_canonical TEXT,                              -- fold target (low_fold); null for raw
    similarity         NUMERIC(5,4),                      -- rejected/low cosine; null for raw
    user_id            UUID,                              -- run context (best-effort, nullable)
    repo_full_name     TEXT,
    model_id           TEXT,                              -- enrichment model that emitted the phrase
    ontology_version   INTEGER,                           -- skill_ontology size at capture
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ontology_gap_kind_phrase ON ontology_resolution_gap (kind, raw_phrase);
CREATE INDEX IF NOT EXISTS idx_ontology_gap_created     ON ontology_resolution_gap (created_at);

-- Ranked "what to add next": the most-frequent unresolved phrases across the
-- user base. distinct_users weights a phrase that many users hit over a single
-- noisy one. avg_similarity stays null until low_fold capture lands.
CREATE OR REPLACE VIEW ontology_gap_candidates AS
SELECT kind,
       raw_phrase,
       count(*)                       AS occurrences,
       count(DISTINCT user_id)        AS distinct_users,
       count(DISTINCT repo_full_name) AS distinct_repos,
       avg(similarity)                AS avg_similarity,
       max(created_at)                AS last_seen
FROM ontology_resolution_gap
GROUP BY kind, raw_phrase;
