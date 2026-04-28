/**
 * @format
 * Platform RDS Bootstrap — DDL runner
 *
 * Runs idempotent DDL: pgvector extension, all platform tables, indexes.
 * Exits 0 on success, non-zero on error (K8s Job backoffLimit handles retries).
 *
 * Connects directly to RDS (not via PgBouncer) — PgBouncer may not be ready
 * on first deploy.
 *
 * Env vars from ESO-synced secrets:
 *   PGHOST      — RDS endpoint (from platform-rds-config)
 *   PGPORT      — 5432 (from platform-rds-config)
 *   PGDATABASE  — tucaken (from platform-rds-config)
 *   PGUSER      — postgres (from platform-rds-credentials)
 *   PGPASSWORD  — auto-generated (from platform-rds-credentials)
 */
import { Pool } from 'pg';

const pool = new Pool({
    host:     process.env.PGHOST,
    port:     parseInt(process.env.PGPORT ?? '5432', 10),
    database: process.env.PGDATABASE,
    user:     process.env.PGUSER,
    password: process.env.PGPASSWORD,
    ssl:      { rejectUnauthorized: false },
    max:      1,
    connectionTimeoutMillis: 10_000,
});

const DDL = `
-- Extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Identity domain
CREATE TABLE IF NOT EXISTS users (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email             TEXT        UNIQUE NOT NULL,
  full_name         TEXT,
  avatar_url        TEXT,
  plan              TEXT        NOT NULL DEFAULT 'free',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS oauth_connections (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT        NOT NULL,
  provider_user_id  TEXT        NOT NULL,
  username          TEXT        NOT NULL,
  access_token_enc  TEXT        NOT NULL,
  scopes            TEXT[],
  connected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

-- Knowledge domain
CREATE TABLE IF NOT EXISTS repositories (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider          TEXT        NOT NULL,
  full_name         TEXT        NOT NULL,
  description       TEXT,
  primary_language  TEXT,
  topics            TEXT[],
  is_private        BOOLEAN     NOT NULL DEFAULT false,
  index_status      TEXT        NOT NULL DEFAULT 'pending',
  indexed_at        TIMESTAMPTZ,
  error_message     TEXT,
  added_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider, full_name)
);

CREATE TABLE IF NOT EXISTS document_embeddings (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           TEXT        NOT NULL,
  repo_full_name    TEXT        NOT NULL,
  file_path         TEXT        NOT NULL,
  heading           TEXT,
  content           TEXT        NOT NULL,
  content_tsv       TSVECTOR    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  file_type         TEXT,
  tags              TEXT[],
  chunk_index       INTEGER     NOT NULL,
  total_chunks      INTEGER     NOT NULL,
  content_hash      TEXT        NOT NULL,
  embedding         vector(1024) NOT NULL,
  last_synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS repo_sync_state (
  user_id           TEXT        NOT NULL,
  repo_full_name    TEXT        NOT NULL,
  sync_status       TEXT        NOT NULL DEFAULT 'pending',
  last_synced_at    TIMESTAMPTZ,
  file_count        INTEGER     NOT NULL DEFAULT 0,
  chunk_count       INTEGER     NOT NULL DEFAULT 0,
  error_message     TEXT,
  PRIMARY KEY (user_id, repo_full_name)
);

-- Career domain
CREATE TABLE IF NOT EXISTS job_applications (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company           TEXT        NOT NULL,
  role              TEXT        NOT NULL,
  job_url           TEXT,
  job_description   TEXT        NOT NULL,
  job_description_tsv TSVECTOR  GENERATED ALWAYS AS (
    to_tsvector('english', company || ' ' || role || ' ' || job_description)
  ) STORED,
  kanban_status     TEXT        NOT NULL DEFAULT 'saved',
  applied_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS resumes (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_application_id UUID       REFERENCES job_applications(id) ON DELETE SET NULL,
  version           INTEGER     NOT NULL DEFAULT 1,
  content_json      JSONB       NOT NULL,
  rendered_html     TEXT,
  source_chunk_ids  UUID[],
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS interview_stages (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_application_id UUID       NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  stage_type        TEXT        NOT NULL,
  scheduled_at      TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  outcome           TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS coaching_content (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_application_id UUID       NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  stage_type        TEXT        NOT NULL,
  topics_to_study   JSONB,
  expected_questions JSONB,
  personal_highlights JSONB,
  source_chunk_ids  UUID[],
  generated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_application_id, stage_type)
);

-- Content domain
CREATE TABLE IF NOT EXISTS articles (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              TEXT        UNIQUE NOT NULL,
  title             TEXT        NOT NULL,
  excerpt           TEXT,
  content_md        TEXT        NOT NULL,
  content_tsv       TSVECTOR    GENERATED ALWAYS AS (
    to_tsvector('english', title || ' ' || COALESCE(excerpt,'') || ' ' || content_md)
  ) STORED,
  tags              TEXT[],
  author_id         UUID        REFERENCES users(id),
  status            TEXT        NOT NULL DEFAULT 'draft',
  ai_generated      BOOLEAN     NOT NULL DEFAULT false,
  ai_model          TEXT,
  published_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Platform domain
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id),
  pipeline_type     TEXT        NOT NULL,
  reference_id      TEXT,
  status            TEXT        NOT NULL DEFAULT 'queued',
  error_message     TEXT,
  metadata          JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT        NOT NULL,
  key_hash          TEXT        NOT NULL UNIQUE,
  key_prefix        TEXT        NOT NULL,
  scopes            TEXT[],
  last_used_at      TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_config (
  key               TEXT        PRIMARY KEY,
  value             JSONB       NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ingestion_audit_log (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id),
  repo_full_name    TEXT        NOT NULL,
  triggered_by      TEXT,
  status            TEXT        NOT NULL,
  duration_ms       INTEGER,
  chunks_embedded   INTEGER,
  chunks_skipped    INTEGER,
  chunks_pruned     INTEGER,
  error_message     TEXT,
  triggered_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_natural_key
  ON document_embeddings (user_id, repo_full_name, file_path, chunk_index);
CREATE INDEX IF NOT EXISTS idx_embeddings_hnsw
  ON document_embeddings USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_embeddings_content_tsv
  ON document_embeddings USING GIN (content_tsv);
CREATE INDEX IF NOT EXISTS idx_articles_slug   ON articles (slug);
CREATE INDEX IF NOT EXISTS idx_articles_status ON articles (status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_articles_tags   ON articles USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_articles_tsv    ON articles USING GIN (content_tsv);
CREATE INDEX IF NOT EXISTS idx_job_apps_user   ON job_applications (user_id, kanban_status);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs   ON pipeline_runs (user_id, pipeline_type, status);

-- Phase 2 schema patches (idempotent)
ALTER TABLE articles ADD COLUMN IF NOT EXISTS cover_image TEXT;
ALTER TABLE job_applications ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE resumes ALTER COLUMN user_id DROP NOT NULL;

-- KB enrichment: per-chunk structured metadata (frontmatter, future enrichment).
-- Pick #1 in the Tucaken-product roadmap (frontmatter + wikilinks).
ALTER TABLE document_embeddings
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_embeddings_metadata
  ON document_embeddings USING GIN (metadata jsonb_path_ops);

-- KB skill-evidence enrichment columns. Pick #2 in the roadmap.
-- skills:        domain capabilities the chunk evidences (e.g. "kubernetes networking")
-- technologies:  named tools/products in use (e.g. "calico", "traefik")
-- Both flat TEXT[] for fast facet via GIN — richer evidence (level, quote)
-- continues to live in metadata JSONB.
ALTER TABLE document_embeddings
  ADD COLUMN IF NOT EXISTS skills       TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS technologies TEXT[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_embeddings_skills
  ON document_embeddings USING GIN (skills);
CREATE INDEX IF NOT EXISTS idx_embeddings_technologies
  ON document_embeddings USING GIN (technologies);
`;

async function main(): Promise<void> {
    console.log('Platform RDS bootstrap starting...');
    let client;
    try {
        client = await pool.connect();
        console.log('Running DDL...');
        await client.query(DDL);
        console.log('Bootstrap complete.');
    } finally {
        client?.release();
        await pool.end();
    }
}

main().catch((err) => {
    console.error('Bootstrap failed:', err);
    process.exit(1);
});
