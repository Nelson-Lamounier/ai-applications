-- =============================================================================
-- 094_skill_ontology_embedding.sql
-- =============================================================================
-- Skill-canonicalisation, embedding-resolution foundation (FOLLOWUP item 4,
-- "align skill ontology to external taxonomy"; sub-slice A).
--
-- Live data (tucaken-infra re-sync, 2026-06-18) showed 5,004 distinct free-text
-- skill phrases across one repo — exact-alias resolution can't collapse
-- descriptive LLM output ("auto scaling group configuration"). The chosen fix is
-- nearest-canonical resolution over Titan embeddings (our own infra, no external
-- runtime dependency): embed each canonical skill once, resolve a free-text
-- phrase to its nearest canonical by cosine similarity above a threshold.
--
-- This slice adds the storage + index. Populating the column (taxonomy import +
-- Titan backfill) is sub-slice B; the enricher wiring is C; threshold/eval is D
-- (gates C, per the repo's per-phase-eval rule). Idempotent.
--
-- vector(1024) + hnsw cosine, mirroring document_embeddings / repository_profiles.
-- =============================================================================

ALTER TABLE skill_ontology
    ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- HNSW cosine index — same params as the other embedding tables. The ontology is
-- small (~10^4 rows), so this is cheap and keeps nearest-canonical lookups fast.
CREATE INDEX IF NOT EXISTS idx_skill_ontology_embedding
    ON skill_ontology USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
