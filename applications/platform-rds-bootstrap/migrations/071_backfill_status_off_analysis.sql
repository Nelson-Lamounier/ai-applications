-- =============================================================================
-- Migration 071 — backfill: advance applications off the transient analysis status
--
-- `analysing` / `analysis-ready` are only meaningful while the Research Agent
-- runs. Applications that have since started interview prep (the coach produced
-- content for a stage, or a stage was scheduled / advanced) were left stuck on
-- the transient status because nothing auto-advanced it once analysis completed
-- — so the list read "Ready for Review" forever.
--
-- This one-time backfill moves those engaged applications to 'interview-prep'.
-- Going forward, admin-api `advanceStatusOffAnalysis` (called when a stage is
-- scheduled) keeps the status off the transient analysis states. Idempotent.
-- =============================================================================

UPDATE job_applications ja
   SET kanban_status = 'interview-prep',
       updated_at    = NOW()
 WHERE ja.kanban_status IN ('analysing', 'analysis-ready')
   AND (
     EXISTS (
       SELECT 1 FROM coaching_content c
        WHERE c.job_application_id = ja.id
     )
     OR EXISTS (
       SELECT 1 FROM interview_stages s
        WHERE s.job_application_id = ja.id
          AND (s.coach_run_id IS NOT NULL
               OR s.scheduled_at IS NOT NULL
               OR s.stage_status IN ('current', 'completed'))
     )
   );
