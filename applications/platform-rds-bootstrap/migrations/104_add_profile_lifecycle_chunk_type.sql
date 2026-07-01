-- 104_add_profile_lifecycle_chunk_type.sql -- allow 'lifecycle' profile chunks. Idempotent.
--
-- Adds a fourth profile-embedding chunk_type, 'lifecycle', carrying a repo's
-- migration/timeline fact (e.g. "currently EKS, migrated from kubeadm") so the
-- chatbot can answer temporally. The CHECK in 014 is an inline column constraint
-- named repository_profile_embeddings_chunk_type_check; drop and re-add it.

BEGIN;

ALTER TABLE repository_profile_embeddings
  DROP CONSTRAINT IF EXISTS repository_profile_embeddings_chunk_type_check;

ALTER TABLE repository_profile_embeddings
  ADD CONSTRAINT repository_profile_embeddings_chunk_type_check
  CHECK (chunk_type IN ('one_liner', 'description', 'highlight', 'lifecycle'));

COMMIT;
