/**
 * @format
 * Platform RDS Bootstrap — reusable DDL + migration runner
 *
 * Exposes the base DDL string, the on-disk migration loader, and a
 * `runBootstrap` function that applies them in order against a pg `Pool`.
 * Used both by the K8s Job entrypoint (`index.ts`) and by the E2E
 * migration test (`scripts/test-projects-migration.ts`).
 *
 * The split keeps `index.ts` side-effect-free at module load: previously
 * the pool was created and `main()` was invoked at the top level, which
 * made the module impossible to import for testing.
 *
 * The DDL string is byte-for-byte the one that previously lived inside
 * `index.ts` (verified against develop). The only addition is a guarded
 * `CREATE ROLE tucaken_app` so numbered migrations whose GRANTs reference
 * the role can apply against a fresh database — previously the role was
 * created out-of-band on the dev cluster.
 */
import { Pool } from 'pg';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const DDL = `
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

-- KB quality scoring (pick #4): observable signal of how good a repo's
-- ingestion is for resume generation. Computed at end of ingestion.
ALTER TABLE repo_sync_state
  ADD COLUMN IF NOT EXISTS kb_quality_score     NUMERIC(4,2),
  ADD COLUMN IF NOT EXISTS kb_quality_breakdown JSONB;

-- GitHub App integration (pick #5): store installation_id per OAuth connection
-- so the server can generate short-lived installation tokens on demand.
-- installation_id is the numeric ID GitHub assigns when a user installs the App.
ALTER TABLE oauth_connections
  ADD COLUMN IF NOT EXISTS installation_id TEXT;

-- default_branch tracks which branch the ingestion Job targets per connected repo.
ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS default_branch TEXT NOT NULL DEFAULT 'main';

-- Application role used by GRANTs in numbered migrations. Created here
-- (idempotent) so a fresh database can apply every migration without
-- requiring out-of-band role creation. Existing dev/prod clusters where
-- the role already exists are unaffected.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tucaken_app') THEN
    CREATE ROLE tucaken_app NOLOGIN;
  END IF;
END$$;

-- Generic updated_at trigger function. Used by migrations 014, 015, 030,
-- and likely future ones. Previously created out-of-band on dev/prod;
-- defining it here keeps fresh databases buildable from migrations alone.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`;

export function loadMigrations(
    migrationsDir: string = path.resolve(__dirname, '../migrations'),
): { name: string; sql: string }[] {
    if (!fs.existsSync(migrationsDir)) return [];
    return fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => ({
            name: f,
            sql:  fs.readFileSync(path.join(migrationsDir, f), 'utf8'),
        }));
}

export function createPool(overrides: Partial<ConstructorParameters<typeof Pool>[0]> = {}): Pool {
    return new Pool({
        host:     process.env.PGHOST,
        port:     parseInt(process.env.PGPORT ?? '5432', 10),
        database: process.env.PGDATABASE,
        user:     process.env.PGUSER,
        password: process.env.PGPASSWORD,
        ssl:      process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
        max:      1,
        connectionTimeoutMillis: 10_000,
        ...overrides,
    });
}

export async function runBootstrap(pool: Pool): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query(DDL);
        const migrations = loadMigrations();
        for (const { name, sql } of migrations) {
            console.log(`  → ${name}`);
            await client.query(sql);
        }
    } finally {
        client.release();
    }
}
