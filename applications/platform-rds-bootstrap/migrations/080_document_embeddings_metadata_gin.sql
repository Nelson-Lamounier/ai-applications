-- =============================================================================
-- 080_document_embeddings_metadata_gin.sql
-- =============================================================================
-- Indexes the evidence-metadata stamp (is_fork, repo_classification, authored,
-- role_inferred, repo_tech_stack, …) written onto document_embeddings.metadata by
-- stamp-evidence-metadata.ts, so filter-then-rank retrieval can apply the
-- structural gates + tech pre-filter without a sequential scan or a join.
--
-- jsonb_path_ops GIN: smaller + faster for the containment/`?|`/`->>` filters the
-- retrieval WHERE uses. Idempotent (IF NOT EXISTS).
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_document_embeddings_metadata_gin
    ON document_embeddings USING gin (metadata jsonb_path_ops);
