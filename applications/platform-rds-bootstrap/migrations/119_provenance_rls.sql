-- 119_provenance_rls.sql — add per-user RLS to the provenance tables (F12).
--
-- repo_profile (078), evidence_provenance (076), and repo_evidence_quality (077) all
-- carry a `user_id UUID NOT NULL` column but were created without row-level security,
-- against this repo's RLS guardrail. Mirrors the standard per-user isolation policy
-- (see 034_technology_evidence.sql, 054_dsa_evidence.sql): USING keys on the session
-- GUC app.current_user_id, and — because no explicit WITH CHECK is given — Postgres
-- also applies the USING expression as the INSERT WITH CHECK.
--
-- DEPLOY-ORDER WARNING: the job-strategist image carrying the withUserRls writer
-- changes (persistRepoProfiles / persistEvidenceProvenance / persistRepoEvidenceQuality
-- now set app.current_user_id via withUserRls before each INSERT) MUST be LIVE
-- before or together with this migration. Until that image ships, all three writers
-- issue a bare `pool.query` with no RLS context set; once RLS is enabled here,
-- current_setting('app.current_user_id', true) reads NULL on those connections, the
-- USING/WITH CHECK expression evaluates to NULL (not true), and every provenance
-- INSERT is silently rejected — these writers are fire-and-forget .catch() call
-- sites, so the failure would not surface as a pipeline error, only as missing rows.
--
-- Idempotent.
BEGIN;

ALTER TABLE repo_profile ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS repo_profile_user_isolation ON repo_profile;
CREATE POLICY repo_profile_user_isolation ON repo_profile
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

ALTER TABLE evidence_provenance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS evidence_provenance_user_isolation ON evidence_provenance;
CREATE POLICY evidence_provenance_user_isolation ON evidence_provenance
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

ALTER TABLE repo_evidence_quality ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS repo_evidence_quality_user_isolation ON repo_evidence_quality;
CREATE POLICY repo_evidence_quality_user_isolation ON repo_evidence_quality
  USING (user_id = current_setting('app.current_user_id', true)::uuid);

COMMIT;
