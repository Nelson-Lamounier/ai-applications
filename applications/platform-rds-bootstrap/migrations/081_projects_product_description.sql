-- =============================================================================
-- 081_projects_product_description.sql
-- =============================================================================
-- Product-purpose override for project case studies.
--
-- The case-study generator grounds every claim in code (commits/PRs/files),
-- which biases the pitch toward infrastructure detail and never states WHAT the
-- product is, WHO it serves, or WHAT PROBLEM it solves — those facts live in no
-- citable commit. This column lets the user record the product purpose in one or
-- two sentences (e.g. "Tucaken: connect your GitHub to generate JD-tailored
-- resumes from verified skills"). The loader feeds it to the agent as
-- ground-truth context (highest precedence over repo description + root README),
-- so the pitch can open with the product story before the engineering depth.
--
-- Additive + idempotent. Absent (NULL) → loader falls back to repo description /
-- root README, preserving today's behavior.
-- =============================================================================

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS product_description TEXT;
