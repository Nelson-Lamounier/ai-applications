/**
 * @format
 * Helpers for the platform RDS pipeline_runs status table and the
 * strategist-specific persistence (job_applications, resumes).
 */
import type { Pool } from 'pg';

import { StructuredResumeDataSchema } from '../schemas/resume-data.schema.js';

/**
 * Update a pipeline_runs row's status (and optional error message).
 *
 * Strategist status flow: queued → researching → analysing → complete (or failed).
 */
export async function updatePipelineRun(
    pool: Pool,
    id: string,
    status: string,
    errorMessage?: string,
): Promise<void> {
    await pool.query(
        `UPDATE pipeline_runs SET status = $2, error_message = $3, updated_at = NOW() WHERE id = $1`,
        [id, status, errorMessage ?? null],
    );
}

/**
 * Update job_applications kanban_status. Called as the analysis pipeline
 * progresses ('analysing' → 'analysis-ready' / 'failed').
 */
export async function updateJobApplicationStatus(
    pool: Pool,
    applicationId: string,
    kanbanStatus: string,
): Promise<void> {
    await pool.query(
        `UPDATE job_applications SET kanban_status = $2, updated_at = NOW() WHERE id = $1`,
        [applicationId, kanbanStatus],
    );
}

/**
 * Persist the Strategist-authored tailored resume to PG resumes.
 *
 * Option A: the Strategist Agent owns the full StructuredResumeData
 * (no separate Resume Builder LLM patch step). This helper validates
 * against the Zod schema and upserts to the resumes table.
 *
 * label and is_active are embedded in content_json (Phase 2 design).
 */
export async function persistTailoredResume(
    pool: Pool,
    args: {
        applicationId:   string;
        userId:          string;
        pipelineId:      string;
        targetRole:      string;
        archetype:       string | null;
        tailoredResume:  unknown;        // raw — validated below
    },
): Promise<{ resumeId: string } | null> {
    const validated = StructuredResumeDataSchema.safeParse(args.tailoredResume);
    if (!validated.success) {
        console.warn('[strategist] tailored_resume_json failed schema validation — skipping persistence', {
            pipelineId: args.pipelineId, error: validated.error.message,
        });
        return null;
    }

    const resumeId = `${args.applicationId}-${args.pipelineId}`;
    const contentJson = {
        ...validated.data,
        label:      `Tailored — ${args.targetRole}${args.archetype ? ` (${args.archetype})` : ''}`,
        is_active:  false,
    };

    await pool.query(
        `INSERT INTO resumes (id, user_id, job_application_id, content_json)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET content_json = EXCLUDED.content_json, generated_at = NOW()`,
        [resumeId, args.userId, args.applicationId, JSON.stringify(contentJson)],
    );
    return { resumeId };
}
