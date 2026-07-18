-- Migration 123 - concept_evidence: detector-backed concept facts (spec P2),
-- plus two new skill_ontology canonicals + missing skill_aliases entries so
-- the concept detectors resolve onto the shared ontology (092/093 idiom).
BEGIN;

CREATE TABLE IF NOT EXISTS concept_evidence (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        UUID NOT NULL,
    repo_full_name TEXT NOT NULL,
    github_repo_id BIGINT,
    skill_id       UUID NOT NULL REFERENCES skill_ontology(id) ON DELETE CASCADE,
    detector       TEXT NOT NULL,
    file_path      TEXT NOT NULL,
    line_start     INT,
    confidence     REAL NOT NULL DEFAULT 1.0,
    commit_sha     TEXT NOT NULL,
    extracted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, repo_full_name, skill_id, detector, file_path)
);
CREATE INDEX IF NOT EXISTS idx_concept_evidence_repo
    ON concept_evidence (user_id, repo_full_name);

ALTER TABLE concept_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_concept_evidence ON concept_evidence;
CREATE POLICY rls_concept_evidence ON concept_evidence
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON concept_evidence TO tucaken_app;

-- --- Ontology seeds (092/093 idiom): new canonicals + missing aliases --------
-- 'devops' and 'architecture' are both valid skill_ontology.category values
-- (see the CHECK constraint in 092_skill_ontology.sql).
--
-- NOTE: 'distributed systems' already exists in skill_ontology as an
-- auto_imported row (093's bootstrap from role_ontology.transferable_skills,
-- see 072_role_ontology.sql) with category 'other', so the INSERT below
-- no-ops for it; the UPDATE that follows upgrades that pre-existing row to
-- the intended curated metadata. Both statements are idempotent.
INSERT INTO skill_ontology (canonical_name, display_name, category, curation_level, source)
VALUES ('process automation', 'Process Automation', 'devops', 'curated', 'p2-concepts'),
       ('distributed systems', 'Distributed Systems', 'architecture', 'curated', 'p2-concepts')
ON CONFLICT (canonical_name) DO NOTHING;

-- Upgrade the 093-bootstrapped 'distributed systems' row (auto_imported /
-- 'other') to the curated metadata intended above. Idempotent: the
-- curation_level guard makes this a no-op on re-run and on fresh databases
-- where the INSERT above created the row as 'curated' directly.
UPDATE skill_ontology SET category = 'architecture', curation_level = 'curated'
 WHERE canonical_name = 'distributed systems' AND curation_level = 'auto_imported';

-- Aliases (lowercased) -> canonical skill. 'ci-cd' and 'ci/cd pipeline design'
-- are additional synonyms for the existing 'ci/cd pipelines' canonical seeded
-- in 092 (not already aliased there: 092 only has 'ci/cd pipelines', 'ci/cd',
-- 'cicd').
INSERT INTO skill_aliases (alias, skill_id, source)
SELECT a.alias, so.id, 'p2-concepts'
FROM skill_ontology so
JOIN (VALUES
    ('process automation',     'process automation'),
    ('distributed systems',    'distributed systems'),
    ('ci-cd',                  'ci/cd pipelines'),
    ('ci/cd pipeline design',  'ci/cd pipelines')
) AS a(alias, canonical) ON a.canonical = so.canonical_name
ON CONFLICT (alias) DO NOTHING;

COMMIT;
