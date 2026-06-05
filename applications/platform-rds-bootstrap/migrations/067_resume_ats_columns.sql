-- 067_resume_ats_columns.sql
-- Adds ATS artifacts to resumes: the canonical text-selectable PDF S3 key and
-- the in-pipeline parse-back check result. Idempotent (ADD COLUMN IF NOT EXISTS),
-- matching the established migration style in this directory.

ALTER TABLE resumes ADD COLUMN IF NOT EXISTS pdf_s3_key     TEXT;
ALTER TABLE resumes ADD COLUMN IF NOT EXISTS ats_check_json JSONB;
