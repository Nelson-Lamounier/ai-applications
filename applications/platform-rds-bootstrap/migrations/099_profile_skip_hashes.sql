-- 099_profile_skip_hashes.sql
--
-- Skip-unchanged hashes (WS4 of the profile-LLM hardening). profile-extract and
-- the 3-4 rollup-synthesis LLMs currently re-run on EVERY sync/resync/build with
-- no change detection — paying full LLM cost even when a repo (or the whole repo
-- set) is byte-identical to last time. These two hashes gate that:
--   * repository_profiles.profile_input_hash  — skip the per-repo extract LLM when
--     the repo's profile inputs (README/manifests/HEAD/commits) are unchanged.
--   * user_profile_rollup.synthesis_input_hash — skip the synthesis LLMs when the
--     aggregate rollup is unchanged. Keyed on the aggregate, so add/delete/modify
--     of ANY repo changes the hash and forces a re-synthesis; a true no-op skips.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Nullable — a NULL hash means "never
-- computed", which always forces the work (safe default).

BEGIN;

ALTER TABLE repository_profiles
    ADD COLUMN IF NOT EXISTS profile_input_hash TEXT;

ALTER TABLE user_profile_rollup
    ADD COLUMN IF NOT EXISTS synthesis_input_hash TEXT;

COMMIT;
