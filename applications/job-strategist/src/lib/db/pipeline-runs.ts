/**
 * @format
 * Helpers for the platform RDS pipeline_runs status table and the
 * strategist-specific persistence (job_applications, resumes).
 */
import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';
import type { InterviewCoachResult } from '@bedrock/shared';

import { StructuredResumeDataSchema } from '../../schemas/resume-data.schema.js';
import { withUserRls } from './rls.js';

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
 * Update the metadata JSON column on a pipeline_runs row.
 *
 * Used by the strategist run to stash the analysis result so a downstream
 * coach K8s Job can re-hydrate it without re-running the upstream agents.
 */
export async function updatePipelineRunMetadata(
    pool: Pool,
    id: string,
    metadata: Record<string, unknown>,
): Promise<void> {
    await pool.query(
        `UPDATE pipeline_runs SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [id, JSON.stringify(metadata)],
    );
}

/**
 * Persist coaching content output by the Interview Coach Agent.
 *
 * coaching_content has a unique constraint on (job_application_id, stage_type),
 * so we upsert to allow regeneration.
 */
export async function persistCoachingContent(
    pool: Pool,
    args: {
        applicationId: string;
        stageType:     string;
        coaching:      InterviewCoachResult;
    },
): Promise<void> {
    const coachingUnknown = args.coaching as unknown as Record<string, unknown>;
    const personalHighlights =
        (coachingUnknown['personalisationHighlights'] as unknown[] | undefined) ??
        (coachingUnknown['personalHighlights']        as unknown[] | undefined) ??
        [];

    await pool.query(
        `INSERT INTO coaching_content (job_application_id, stage_type, topics_to_study, expected_questions, personal_highlights)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (job_application_id, stage_type) DO UPDATE SET
             topics_to_study     = EXCLUDED.topics_to_study,
             expected_questions  = EXCLUDED.expected_questions,
             personal_highlights = EXCLUDED.personal_highlights,
             generated_at        = NOW()`,
        [
            args.applicationId,
            args.stageType,
            JSON.stringify(args.coaching),
            JSON.stringify({
                technical:   args.coaching.technicalQuestions   ?? [],
                behavioural: args.coaching.behaviouralQuestions ?? [],
                difficult:   args.coaching.difficultQuestions   ?? [],
            }),
            JSON.stringify(personalHighlights),
        ],
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

/** A project entry is persistable only with a non-empty name AND description. */
function isUsableProject(p: unknown): boolean {
    if (typeof p !== 'object' || p === null) return false;
    const entry = p as Record<string, unknown>;
    const name = entry['name'];
    const description = entry['description'];
    return typeof name === 'string' && name.trim().length > 0
        && typeof description === 'string' && description.trim().length > 0;
}

/**
 * Strip project entries the LLM emitted without a usable description before the
 * resume is validated for persistence.
 *
 * The Strategist occasionally returns a `projects[]` entry missing `description`
 * (most likely when the user has no grounded Project to draw on). Because
 * StructuredResumeDataSchema requires `description`, a single such entry would
 * fail safeParse and void the WHOLE persist — silently dropping an otherwise
 * complete resume (and, on the post-ATS re-persist, the keyword improvements).
 * Dropping just the malformed project keeps the rest. Returns the input
 * unchanged (same reference) when nothing needs removing.
 */
export function dropInvalidProjects(raw: unknown): { resume: unknown; droppedProjects: number } {
    if (typeof raw !== 'object' || raw === null) return { resume: raw, droppedProjects: 0 };
    const record = raw as Record<string, unknown>;
    const projects = record['projects'];
    if (!Array.isArray(projects)) return { resume: raw, droppedProjects: 0 };

    const cleaned = projects.filter(isUsableProject);
    const droppedProjects = projects.length - cleaned.length;
    if (droppedProjects === 0) return { resume: raw, droppedProjects: 0 };

    return { resume: { ...record, projects: cleaned }, droppedProjects };
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
    // Salvage a resume with a single malformed project rather than dropping the
    // whole persist (the re-persist after the ATS/keyword pass used to die here).
    const { resume: cleanedResume, droppedProjects } = dropInvalidProjects(args.tailoredResume);
    if (droppedProjects > 0) {
        console.warn('[strategist] dropped malformed project entries before persistence', {
            pipelineId: args.pipelineId, droppedProjects,
        });
    }

    const validated = StructuredResumeDataSchema.safeParse(cleanedResume);
    if (!validated.success) {
        console.warn('[strategist] tailored_resume_json failed schema validation — skipping persistence', {
            pipelineId: args.pipelineId, error: validated.error.message,
        });
        return null;
    }

    // Use pipelineId (already a UUID) as the resume ID so ON CONFLICT handles
    // retries deterministically. A compound string like "${appId}-${pipelineId}"
    // is not a valid UUID and would fail the resumes.id UUID column constraint.
    const resumeId = args.pipelineId || randomUUID();
    const label    = `Tailored — ${args.targetRole}${args.archetype ? ` (${args.archetype})` : ''}`;

    // resumes is RLS-protected (resumes_isolation). Run the upsert inside the
    // user's RLS context — see withUserRls. The INSERT previously worked only
    // because a pooled connection happened to carry the right context; making it
    // explicit removes that fragility (and the dependence that left the ATS
    // UPDATE failing on a stale/mismatched context).
    await withUserRls(pool, args.userId, async (client) => {
        const res = await client.query(
            `INSERT INTO resumes (id, user_id, job_application_id, content_json, label, is_active)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO UPDATE SET
                 content_json = EXCLUDED.content_json,
                 label        = EXCLUDED.label,
                 generated_at = NOW()`,
            [resumeId, args.userId, args.applicationId, JSON.stringify(validated.data), label, false],
        );
        if (res.rowCount === 0) {
            throw new Error(`persistTailoredResume: upsert affected 0 rows for resume ${resumeId}`);
        }
    });
    return { resumeId };
}
