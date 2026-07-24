-- ============================================================================
-- 124_resume_bullets_troubleshooting_angle.sql
--
-- Widen project_resume_bullets.angle to accept 'troubleshooting'.
--
-- WHY: support-weighted JDs (Technical Support Engineer and similar -- half
-- the recent live targets) hire for diagnostic narratives (symptom ->
-- investigation -> root cause -> resolution -> documentation), but the
-- case-study generator's angle taxonomy was entirely builder-shaped
-- (backend / frontend / infrastructure / fullstack / data_ml /
-- product_leadership), so no diagnostic-narrative bullet set could exist in
-- the pool. The live Salesforce TSE run (2026-07-24) shipped a projects
-- section covering 1 of 6 ATS targets because the selector had only
-- builder-framed bullets to choose from.
--
-- Mirrored in code by RESUME_BULLET_ANGLES
-- (applications/shared/src/projects/case-study/case-study-types.ts) -- SQL
-- remains the source of truth for the enum (see that file's module doc).
--
-- DEPLOY ORDER: apply this migration BEFORE (or with) the image carrying the
-- widened RESUME_BULLET_ANGLES -- an agent emitting 'troubleshooting' against
-- the old CHECK would fail the bullet-set INSERT.
-- ============================================================================

ALTER TABLE project_resume_bullets
    DROP CONSTRAINT IF EXISTS project_resume_bullets_angle_check;

ALTER TABLE project_resume_bullets
    ADD CONSTRAINT project_resume_bullets_angle_check CHECK (angle IN (
        'backend', 'frontend', 'infrastructure',
        'fullstack', 'data_ml', 'product_leadership',
        'troubleshooting'
    ));
