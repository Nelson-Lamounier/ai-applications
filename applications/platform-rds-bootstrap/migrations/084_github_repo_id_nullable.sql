-- =============================================================================
-- 084_github_repo_id_nullable.sql
-- =============================================================================
-- Phase 1 of the GitHub repository rename re-key.
--
-- Today every repo-scoped row is keyed on the mutable `repo_full_name`
-- (`owner/name`). When a repository is renamed on GitHub its full name changes,
-- silently orphaning all of its ingested rows from the live repo. The fix is to
-- anchor every repo-scoped table on GitHub's immutable numeric repo id
-- (`github_repo_id`) so a rename is a metadata update, not a re-ingest.
--
-- This migration is the additive, fully reversible first step:
--   * adds a NULLABLE `github_repo_id BIGINT` column to `repositories` (the
--     anchor) and to every repo-scoped table;
--   * adds a non-unique `(user_id, github_repo_id)` lookup index per table so the
--     later backfill + read cut-over has an index to land on.
--
-- No existing reads change and nothing is backfilled here — the column stays
-- NULL until Phase 2 populates it. Because every statement is additive and
-- idempotent (`IF NOT EXISTS`), this migration is safe to re-run and is reversed
-- simply by dropping the columns/indexes.
--
-- prompt_invocations is repo-scoped via `repo_name` (not `repo_full_name`) and
-- its `user_id` is nullable; the column + index are still added uniformly.
--
-- See: docs spec "GitHub repository rename handling — re-key on immutable id".
-- =============================================================================

-- --- Anchor table -----------------------------------------------------------
ALTER TABLE repositories            ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;

-- --- Repo-scoped tables ------------------------------------------------------
ALTER TABLE document_embeddings     ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE repo_file_state         ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE repo_sync_state         ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE repository_profiles     ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE repo_profile            ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE repo_commits            ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE repo_pull_requests      ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE repo_evidence_quality   ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE evidence_provenance     ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE ai_evidence             ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE ai_scanned_commits      ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE dsa_evidence            ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE dsa_scanned_commits     ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE technology_evidence     ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE technology_parity_runs  ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE story_candidates        ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE ingestion_audit_log     ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE retrieval_probe_history ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;
ALTER TABLE prompt_invocations      ADD COLUMN IF NOT EXISTS github_repo_id BIGINT;

-- --- Lookup indexes: (user_id, github_repo_id) ------------------------------
-- Non-unique; supports the Phase 2 backfill + read cut-over. Names kept under
-- Postgres's 63-char identifier limit.
CREATE INDEX IF NOT EXISTS idx_document_embeddings_user_ghid     ON document_embeddings     (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_repo_file_state_user_ghid         ON repo_file_state         (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_repo_sync_state_user_ghid         ON repo_sync_state         (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_repository_profiles_user_ghid     ON repository_profiles     (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_repo_profile_user_ghid            ON repo_profile            (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_repo_commits_user_ghid            ON repo_commits            (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_repo_pull_requests_user_ghid      ON repo_pull_requests      (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_repo_evidence_quality_user_ghid   ON repo_evidence_quality   (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_evidence_provenance_user_ghid     ON evidence_provenance     (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_ai_evidence_user_ghid             ON ai_evidence             (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_ai_scanned_commits_user_ghid      ON ai_scanned_commits      (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_dsa_evidence_user_ghid            ON dsa_evidence            (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_dsa_scanned_commits_user_ghid     ON dsa_scanned_commits     (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_technology_evidence_user_ghid     ON technology_evidence     (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_technology_parity_runs_user_ghid  ON technology_parity_runs  (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_story_candidates_user_ghid        ON story_candidates        (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_ingestion_audit_log_user_ghid     ON ingestion_audit_log     (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_retrieval_probe_hist_user_ghid    ON retrieval_probe_history (user_id, github_repo_id);
CREATE INDEX IF NOT EXISTS idx_prompt_invocations_user_ghid      ON prompt_invocations      (user_id, github_repo_id);
