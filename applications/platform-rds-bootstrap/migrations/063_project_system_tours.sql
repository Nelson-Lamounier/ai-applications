-- 063_project_system_tours.sql — S7a: per-project "system tour" walkthrough (grounded
-- re-projection of the project's case study) for architecture-review / system-design prep.
-- Mirrors the project_* tables' ownership + RLS (030_projects.sql): user_id + project_id, RLS on user_id.
-- One tour per project (project_id UNIQUE). content = the SystemTour payload; content_hash = the
-- case-study input hash for cache/idempotency. Idempotent.
BEGIN;

CREATE TABLE IF NOT EXISTS project_system_tours (
  user_id      UUID            NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id   UUID            NOT NULL REFERENCES projects(id) ON DELETE CASCADE UNIQUE,
  content      JSONB           NOT NULL,
  content_hash TEXT            NOT NULL,
  generated_at TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_system_tours_user_id ON project_system_tours (user_id);

ALTER TABLE project_system_tours ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rls_project_system_tours ON project_system_tours;
CREATE POLICY rls_project_system_tours ON project_system_tours
  USING      (user_id = current_setting('app.current_user_id', true)::uuid)
  WITH CHECK (user_id = current_setting('app.current_user_id', true)::uuid);

COMMIT;
