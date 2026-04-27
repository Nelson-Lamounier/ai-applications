/**
 * @format
 * Coach K8s Job entrypoint — generates stage-specific interview coaching
 * for an existing job application.
 *
 * Status transitions on pipeline_runs (type='coach'):
 *   queued → coaching → complete (or failed)
 *
 * Inputs:
 *   - COACH_PIPELINE_RUN_ID — this run's id (UPDATE target)
 *   - STRATEGIST_PIPELINE_RUN_ID — source of analysis JSON (loaded from metadata)
 *   - INTERVIEW_STAGE + APPLICATION_ID/SLUG + TARGET_* + JOB_DESCRIPTION
 *
 * Output: a row in coaching_content (job_application_id, stage_type) upserted.
 */
import type { Pool } from 'pg';
import type { StrategistPipelineContext, StrategistAnalysisResult } from '@bedrock/shared';

import { executeCoachAgent }   from './agents/coach-agent.js';
import { parseCoachEnv }       from './env-coach.js';
import { getPool, closePool }  from './lib/pg.js';
import {
    updatePipelineRun,
    persistCoachingContent,
} from './lib/pipeline-runs.js';

async function loadAnalysis(pool: Pool, strategistPipelineRunId: string): Promise<StrategistAnalysisResult> {
    const result = await pool.query<{ metadata: { analysis?: StrategistAnalysisResult } | null }>(
        `SELECT metadata FROM pipeline_runs WHERE id = $1`,
        [strategistPipelineRunId],
    );
    const analysis = result.rows[0]?.metadata?.analysis;
    if (!analysis) {
        throw new Error(`No analysis found in pipeline_runs.metadata for id=${strategistPipelineRunId}`);
    }
    return analysis;
}

async function main(): Promise<void> {
    const env  = parseCoachEnv();
    const pool = getPool(env.pg);

    try {
        const analysis = await loadAnalysis(pool, env.strategistPipelineRunId);

        await updatePipelineRun(pool, env.coachPipelineRunId, 'coaching');

        // Construct StrategistPipelineContext. Some fields are placeholders since
        // the coach path doesn't need resume data or S3 bucket — mirrors the
        // pattern in run-pipeline.ts.
        const ctx: StrategistPipelineContext = {
            pipelineId:        env.coachPipelineRunId,
            operation:         'coach',
            applicationSlug:   env.applicationSlug,
            jobDescription:    env.jobDescription,
            targetCompany:     env.targetCompany,
            targetRole:        env.targetRole,
            resumeId:          process.env['RESUME_ID'] ?? '',
            resumeData:        null,
            interviewStage:    env.interviewStage as StrategistPipelineContext['interviewStage'],
            bucket:            process.env['S3_BUCKET'] ?? '',
            environment:       env.environment,
            cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
            cumulativeCostUsd: 0,
            startedAt:         new Date().toISOString(),
            userId:            env.userId,
        };

        const coaching = await executeCoachAgent(ctx, analysis);

        await persistCoachingContent(pool, {
            applicationId: env.applicationId,
            stageType:     env.interviewStage,
            coaching:      coaching.data,
        });

        await updatePipelineRun(pool, env.coachPipelineRunId, 'complete');

        console.log(JSON.stringify({
            event:              'coach_pipeline_complete',
            coachPipelineRunId: env.coachPipelineRunId,
            applicationId:      env.applicationId,
            stage:              env.interviewStage,
        }));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await updatePipelineRun(pool, env.coachPipelineRunId, 'failed', message)
            .catch(() => { /* swallow — already failing */ });
        console.error(JSON.stringify({
            event:              'coach_pipeline_failed',
            coachPipelineRunId: env.coachPipelineRunId,
            applicationId:      env.applicationId,
            stage:              env.interviewStage,
            error:              message,
        }));
        throw err;
    } finally {
        await closePool();
    }
}

main().catch(() => process.exit(1));
