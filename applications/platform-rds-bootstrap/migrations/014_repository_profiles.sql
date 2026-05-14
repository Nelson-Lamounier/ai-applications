-- applications/platform-rds-bootstrap/migrations/014_repository_profiles.sql

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────────
-- Table: repository_profiles
-- One canonical profile per (user_id, repo_full_name).
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE repository_profiles (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repository_id       UUID            REFERENCES repositories(id) ON DELETE CASCADE,
    repo_full_name      TEXT            NOT NULL,
    extracted           JSONB           NOT NULL DEFAULT '{}',
    user_overrides      JSONB           NOT NULL DEFAULT '{}',
    quality_score       NUMERIC(3,2)    NOT NULL DEFAULT 0
                                        CHECK (quality_score >= 0 AND quality_score <= 1),
    quality_breakdown   JSONB           NOT NULL DEFAULT '{}',
    classification      TEXT            NOT NULL DEFAULT 'project'
                                        CHECK (classification IN
                                          ('project','fork','tutorial','abandoned','noise','stale')),
    is_featured         BOOLEAN         NOT NULL DEFAULT FALSE,
    feature_rank        INTEGER,
    is_hidden           BOOLEAN         NOT NULL DEFAULT FALSE,
    extraction_status   TEXT            NOT NULL DEFAULT 'pending'
                                        CHECK (extraction_status IN
                                          ('pending','extracting','ready_for_review','completed','failed')),
    extraction_error    TEXT,
    extracted_at        TIMESTAMPTZ,
    reviewed_at         TIMESTAMPTZ,
    extractor_model     TEXT,
    extractor_version   TEXT,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT now(),
    UNIQUE (user_id, repo_full_name)
);

CREATE INDEX idx_repo_profiles_user_id
    ON repository_profiles (user_id);

CREATE INDEX idx_repo_profiles_featured
    ON repository_profiles (user_id, feature_rank)
    WHERE is_featured = TRUE;

CREATE INDEX idx_repo_profiles_classification
    ON repository_profiles (user_id, classification);

CREATE INDEX idx_repo_profiles_status
    ON repository_profiles (extraction_status);

-- Faceted tech-stack filtering via JSONB @> operator.
-- Usage: WHERE extracted->'tech_stack' @> '["React"]'::jsonb
CREATE INDEX idx_repo_profiles_tech_stack
    ON repository_profiles USING GIN ((extracted->'tech_stack'));

CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON repository_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE repository_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_repository_profiles ON repository_profiles
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON repository_profiles TO tucaken_app;

-- ──────────────────────────────────────────────────────────────────────────────
-- Table: repository_profile_embeddings
-- Typed semantic chunks per profile. chunk_type is intentionally narrow:
--   - tech_stack is NOT embedded here — it lives in extracted->'tech_stack' JSONB
--   - faceted filtering on tech_stack uses the GIN index above (exact match)
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE repository_profile_embeddings (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_id      UUID            NOT NULL REFERENCES repository_profiles(id) ON DELETE CASCADE,
    chunk_type      TEXT            NOT NULL
                                    CHECK (chunk_type IN ('one_liner', 'description', 'highlight')),
    content         TEXT            NOT NULL,
    content_hash    TEXT            NOT NULL,
    embedding       vector(1024)    NOT NULL,
    metadata        JSONB           NOT NULL DEFAULT '{}',
    last_synced_at  TIMESTAMPTZ     NOT NULL DEFAULT now(),
    UNIQUE (profile_id, chunk_type, content_hash)
);

CREATE INDEX idx_rpe_user_id
    ON repository_profile_embeddings (user_id);

CREATE INDEX idx_rpe_profile_id
    ON repository_profile_embeddings (profile_id);

CREATE INDEX idx_rpe_chunk_type
    ON repository_profile_embeddings (chunk_type);

CREATE INDEX idx_rpe_hnsw
    ON repository_profile_embeddings
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);

ALTER TABLE repository_profile_embeddings ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_repository_profile_embeddings ON repository_profile_embeddings
    USING      (user_id = current_setting('app.current_user_id', true)::uuid)
    WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON repository_profile_embeddings TO tucaken_app;

COMMIT;
