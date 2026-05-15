-- =============================================================================
-- Migration 016 — Resume import corrections log
--
-- Captures (extracted_value, corrected_value) pairs whenever a user edits a
-- career entry after import. Each row is one field-level correction; updating
-- two fields on the same entry produces two rows.
--
-- Purpose:
--   - Eval dataset for extraction prompt iteration and future fine-tuning.
--   - Surface systemic extraction failures (e.g. a model consistently
--     misreading dates) via aggregate queries.
--
-- Retention: indefinite for now — volume is bounded by user edit activity.
-- =============================================================================

CREATE TABLE IF NOT EXISTS resume_import_corrections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id       UUID NOT NULL REFERENCES resume_imports(id)       ON DELETE CASCADE,
  career_entry_id UUID NOT NULL REFERENCES user_career_history(id)  ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id)                ON DELETE CASCADE,

  -- entry_type mirrors user_career_history.entry_type so we can aggregate
  -- corrections by section ('experience' | 'education' | …) without a join.
  entry_type      TEXT NOT NULL,

  -- Dotted JSON-pointer-ish path inside raw_data, e.g. "title", "period",
  -- "highlights[2]". Stored as plain TEXT to keep aggregation queries simple.
  field_path      TEXT NOT NULL,

  -- JSONB so we can store scalars, arrays, or objects without coercion.
  -- NULL extracted_value = field was absent and user added it.
  -- NULL corrected_value = field existed and user removed it.
  extracted_value JSONB,
  corrected_value JSONB,

  -- Model + prompt provenance. model_id is the extraction model that produced
  -- extracted_value. prompt_version is reserved for when extraction prompts
  -- are versioned; nullable until then.
  model_id        TEXT,
  prompt_version  TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Eval queries hit user_id + created_at ranges (recent corrections by user).
CREATE INDEX IF NOT EXISTS idx_corrections_user_created
  ON resume_import_corrections (user_id, created_at DESC);

-- Lookup all corrections for a specific entry (entry detail UI).
CREATE INDEX IF NOT EXISTS idx_corrections_entry
  ON resume_import_corrections (career_entry_id);

-- Aggregate "which fields get corrected most?" queries.
CREATE INDEX IF NOT EXISTS idx_corrections_entry_field
  ON resume_import_corrections (entry_type, field_path);

-- =============================================================================
-- Verification
-- =============================================================================
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'resume_import_corrections'
--   ORDER BY ordinal_position;
-- SELECT indexname FROM pg_indexes WHERE tablename = 'resume_import_corrections';
