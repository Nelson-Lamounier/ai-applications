-- 102_projects_post_sync_action.sql
--
-- Add-time Project intent: a repo's default project can carry an action to apply
-- AFTER its first sync completes -- 'build' (confirm + generate a case study) or
-- 'link' (merge this repo into post_sync_target_project_id + regenerate). NULL
-- means no pending action (KB-only / already applied). Set by the connect route
-- from the user's Add-time choice; cleared by the ingestion Job once applied.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; the CHECK is added only when absent.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS post_sync_action          TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS post_sync_target_project_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.constraint_column_usage
        WHERE table_name = 'projects' AND constraint_name = 'projects_post_sync_action_chk'
    ) THEN
        ALTER TABLE projects
            ADD CONSTRAINT projects_post_sync_action_chk
            CHECK (post_sync_action IS NULL OR post_sync_action IN ('build', 'link'));
    END IF;
END $$;
