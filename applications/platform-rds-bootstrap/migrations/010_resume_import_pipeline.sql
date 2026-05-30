-- =============================================================================
-- Migration 010 — Resume Import Pipeline
--
-- Three tables that support the PDF/DOCX resume upload → Bedrock extraction
-- → Tavily enrichment → pgvector embedding flow.
--
-- Dependency order (no circular FKs):
--   1. resume_imports          — tracks the import job state machine
--   2. user_career_history     — extracted career entries (FK → resume_imports)
--   3. experience_embeddings   — pgvector chunks (FK → user_career_history,
--                                CASCADE DELETE so removing a role cleans up
--                                all its embedding rows automatically)
--
-- Quota: free tier allows 1 import/month and 5 enriched roles.
-- Both limits are enforced at the application layer; schema is unopinionated.
-- =============================================================================

-- =============================================================================
-- 1. resume_imports — import job state machine
-- =============================================================================
CREATE TABLE IF NOT EXISTS resume_imports (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Source tracking
  s3_key                TEXT NOT NULL,
  original_filename     TEXT NOT NULL,
  content_type          TEXT NOT NULL,
  file_size_bytes       INTEGER NOT NULL,

  -- State machine
  -- Valid transitions:
  --   awaiting_upload → queued → parsing → extracting_career
  --   → ready_for_review (returned to user after extraction)
  --   → enriching (background enrichment running per role)
  --   → completed | failed
  status                TEXT NOT NULL DEFAULT 'awaiting_upload',
  status_message        TEXT,
  current_step          TEXT,     -- human-readable progress label for UI
  total_steps           INTEGER,  -- denominator for UI progress bar

  -- Extracted content (kept for debugging extraction quality)
  raw_extracted_text    TEXT,
  extraction_method     TEXT,     -- 'pdf-parse' | 'mammoth'

  -- Results — array of user_career_history.id values created by this import.
  -- Stored as UUID[] (no FK constraint) so we can query what was created
  -- without a join, and so we don't block deletes on user_career_history.
  career_entries_created UUID[] NOT NULL DEFAULT '{}',
  embeddings_created_count INTEGER NOT NULL DEFAULT 0,

  -- Error tracking
  error_code            TEXT,
  error_details         JSONB,
  retry_count           INTEGER NOT NULL DEFAULT 0,

  -- Timestamps
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at            TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_resume_imports_user
  ON resume_imports (user_id, created_at DESC);

-- Partial index for the job-queue query: "find queued imports to process"
CREATE INDEX IF NOT EXISTS idx_resume_imports_status_active
  ON resume_imports (status)
  WHERE status IN ('queued', 'parsing', 'extracting_career', 'enriching');

-- =============================================================================
-- 2. user_career_history — extracted career entries (persistent profile)
-- =============================================================================
--
-- Each row is one entry from the user's career profile.
-- entry_type discriminates the shape of raw_data / enriched_data JSONB.
--
-- raw_data carries the Bedrock-extracted fields from StructuredResumeData:
--   experience:    { company, title, period, highlights[] }
--   education:     { degree, institution, period }
--   skill:         { category, skills[] }
--   certification: { name, year, issuer }
--   project:       { name, description, github? }
--   achievement:   { achievement }
--
-- enriched_data carries the Tavily + Bedrock enrichment output:
--   { roleDescription, responsibilities[], transferableSkills[],
--     industryContext, typicalTechStack[], careerLevel }
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_career_history (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Link back to the import that created this entry (nullable — entries can
  -- also be created manually by the user without an import).
  import_id             UUID REFERENCES resume_imports(id) ON DELETE SET NULL,

  -- Entry type drives the shape of raw_data and how embeddings are chunked.
  entry_type            TEXT NOT NULL,
  -- Allowed values: 'experience' | 'education' | 'skill'
  --                 | 'certification' | 'project' | 'achievement'

  -- Raw extracted data (from Bedrock structured extraction)
  raw_data              JSONB NOT NULL DEFAULT '{}',

  -- Enriched data (from Tavily research + Bedrock synthesis)
  enriched_data         JSONB,

  -- Enrichment state machine
  enrichment_status     TEXT NOT NULL DEFAULT 'pending',
  -- Allowed values: 'pending' | 'enriching' | 'complete' | 'skipped' | 'failed'

  -- Populated when enrichment_status = 'skipped' — explains why.
  -- e.g. 'free_tier_limit' | 'entry_type_not_enrichable'
  enrichment_skipped_reason TEXT,

  -- Display ordering within its entry_type group (ascending)
  display_order         INTEGER NOT NULL DEFAULT 0,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_career_history_user
  ON user_career_history (user_id, entry_type, display_order);

CREATE INDEX IF NOT EXISTS idx_career_history_import
  ON user_career_history (import_id)
  WHERE import_id IS NOT NULL;

-- Partial index for the background enrichment query:
-- "find experience entries for this user that still need enrichment"
CREATE INDEX IF NOT EXISTS idx_career_history_pending_enrichment
  ON user_career_history (user_id, created_at)
  WHERE enrichment_status = 'pending' AND entry_type = 'experience';

-- =============================================================================
-- 3. experience_embeddings — pgvector chunks for similarity search
-- =============================================================================
--
-- One row per semantic chunk derived from a career entry.
-- chunk_type describes what the chunk represents so retrieval queries can
-- weight different chunk types differently when composing resume sections.
--
-- CASCADE DELETE: removing a user_career_history row automatically removes
-- all its embedding rows — no orphaned vectors.
-- =============================================================================
CREATE TABLE IF NOT EXISTS experience_embeddings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  career_entry_id UUID NOT NULL REFERENCES user_career_history(id) ON DELETE CASCADE,

  -- Chunk type discriminator — governs retrieval weighting.
  chunk_type      TEXT NOT NULL,
  -- Allowed values:
  --   'role_description'         — what the role was
  --   'enriched_responsibilities' — Tavily-enriched typical duties
  --   'transferable_skills'      — extracted soft/transferable skills
  --   'industry_context'         — sector/company context
  --   'achievement'              — quantified achievement from highlights

  content         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,  -- SHA-256 of content — skip re-embed if unchanged

  -- Titan embed-text-v2 produces 1024-dimensional vectors (normalised).
  embedding       vector(1024) NOT NULL,

  -- Arbitrary metadata for retrieval filtering (e.g. company, title, period).
  metadata        JSONB NOT NULL DEFAULT '{}',

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_experience_embeddings_user
  ON experience_embeddings (user_id);

CREATE INDEX IF NOT EXISTS idx_experience_embeddings_career_entry
  ON experience_embeddings (career_entry_id);

-- HNSW index for cosine similarity search.
-- m=16 and ef_construction=64 match the document_embeddings index parameters.
CREATE INDEX IF NOT EXISTS idx_experience_embeddings_hnsw
  ON experience_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- =============================================================================
-- Verification
-- =============================================================================
-- SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--     AND table_name IN ('resume_imports', 'user_career_history', 'experience_embeddings');
--
-- SELECT indexname FROM pg_indexes
--   WHERE tablename IN ('resume_imports', 'user_career_history', 'experience_embeddings');
