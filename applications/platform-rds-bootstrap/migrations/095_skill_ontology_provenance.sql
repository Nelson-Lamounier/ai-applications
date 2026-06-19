-- =============================================================================
-- 095_skill_ontology_provenance.sql
-- =============================================================================
-- Skill vocabulary expansion (spec 001-skill-vocabulary-expansion).
--
-- The skill importer (run-skill-import) lifts the 75-row hand-seed to a
-- comprehensive, commercially-safe vocabulary. Every imported canonical MUST
-- record where it came from and under what licence, so the vocabulary's legal
-- basis is auditable (FR-009) and "commercial-safe only" is an enforceable check
-- (SC-003: `source_licence NOT IN (<approved>)` must return zero rows), not a
-- hope.
--
-- This migration adds the provenance columns and stamps the existing 75 curated
-- canonicals as own-curated provenance. The explicit merge of the 7 known
-- near-duplicate seed canonicals lands with the importer's de-dup work (User
-- Story 3, task T019). Idempotent.
-- =============================================================================

ALTER TABLE skill_ontology
    ADD COLUMN IF NOT EXISTS source_licence TEXT,
    ADD COLUMN IF NOT EXISTS source_url     TEXT;

-- The hand-seeded vocabulary is the project's own curated layer — stamp it so
-- the SC-003 audit (which rejects anything off the approved licence allowlist)
-- treats the seed as legitimately-sourced rather than unknown. Idempotent:
-- only fills rows whose provenance is still NULL.
UPDATE skill_ontology
   SET source_licence = 'curated'
 WHERE source_licence IS NULL
   AND curation_level = 'curated';
