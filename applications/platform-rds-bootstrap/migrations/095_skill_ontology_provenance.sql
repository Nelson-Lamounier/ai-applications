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

-- ── Seed de-duplication (FR-006, US3) ───────────────────────────────────────
-- The 75-row seed contains near-duplicate soft-skill canonicals (verified by the
-- live cosine separation matrix, 2026-06-19): merge each duplicate INTO the kept
-- canonical — re-point its aliases, demote its name to an alias of the keep, and
-- deactivate it (kept for audit, not deleted). Idempotent: a re-run finds the
-- duplicate already inactive (the WHERE is_active guard) and the alias already
-- present (ON CONFLICT DO NOTHING).
--
--   keep                          <- drop                          (cosine)
--   cross-functional collaboration <- cross-functional partnership   0.817
--   cross-functional collaboration <- cross-functional leadership    0.678
--   data-driven                    <- data-driven decisions          0.738
--   customer empathy               <- user empathy                   0.692

DO $$
DECLARE
    pair RECORD;
    keep_id UUID;
    drop_id UUID;
BEGIN
    FOR pair IN
        SELECT * FROM (VALUES
            ('cross-functional collaboration', 'cross-functional partnership'),
            ('cross-functional collaboration', 'cross-functional leadership'),
            ('data-driven',                    'data-driven decisions'),
            ('customer empathy',               'user empathy')
        ) AS v(keep_name, drop_name)
    LOOP
        SELECT id INTO keep_id FROM skill_ontology WHERE canonical_name = pair.keep_name;
        SELECT id INTO drop_id FROM skill_ontology WHERE canonical_name = pair.drop_name AND is_active;
        CONTINUE WHEN keep_id IS NULL OR drop_id IS NULL;

        UPDATE skill_aliases SET skill_id = keep_id WHERE skill_id = drop_id;
        INSERT INTO skill_aliases (alias, skill_id, source)
            VALUES (pair.drop_name, keep_id, 'seed-dedup')
            ON CONFLICT (alias) DO NOTHING;
        UPDATE skill_ontology SET is_active = false, updated_at = now() WHERE id = drop_id;
    END LOOP;
END $$;
