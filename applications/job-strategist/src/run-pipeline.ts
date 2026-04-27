/**
 * @format
 * Strategist analysis K8s Job entrypoint — replaces the
 * Trigger / Research / Strategist / Resume-builder / Analysis-persist Lambda
 * chain orchestrated by Step Functions.
 *
 * Status transitions persisted in platform RDS pipeline_runs:
 *   queued → researching → analysing → complete (or failed at any step)
 *
 * Parallel job_applications.kanban_status lifecycle:
 *   <prior> → analysing → analysis-ready (or failed)
 *
 * On Strategist success the Strategist-authored tailored StructuredResumeData
 * (Option A) is validated and persisted to platform RDS resumes.
 */
import type { StrategistPipelineContext } from '@bedrock/shared';

import { executeResearchAgent }   from './agents/research-agent.js';
import { executeStrategistAgent } from './agents/strategist-agent.js';
import { parseEnv }               from './env.js';
import { getPool, closePool }     from './lib/pg.js';
import {
    updatePipelineRun,
    updateJobApplicationStatus,
    persistTailoredResume,
} from './lib/pipeline-runs.js';

async function main(): Promise<void> {
    const env  = parseEnv();
    const pool = getPool(env.pg);

    // Construct the StrategistPipelineContext required by the agents.
    //
    // Notes on field provenance:
    //  - resumeId / resumeData: in the legacy pipeline these were resolved by
    //    the Trigger Lambda (DDB lookup). For the K8s entrypoint they are
    //    expected to be embedded by admin-api at dispatch time. Until Task 4
    //    plumbs them through env vars we default to placeholders — the
    //    Strategist still functions but without the user's structured resume
    //    as Phase 1 input. TODO(phase-4-task-4): pass RESUME_ID + RESUME_DATA
    //    via env (or fetch from PG resumes here).
    //  - bucket: artefact bucket for any S3 offload paths in the agents.
    //    TODO(phase-4-task-4): pass S3_BUCKET via env.
    //  - operation: hard-coded to 'analyse' — the coach pipeline is a separate
    //    Job entrypoint.
    //  - interviewStage: defaults to 'applied' for the analyse path.
    const ctx: StrategistPipelineContext = {
        pipelineId:        env.pipelineId,
        operation:         'analyse',
        applicationSlug:   env.applicationSlug,
        jobDescription:    env.jobDescription,
        targetCompany:     env.targetCompany,
        targetRole:        env.targetRole,
        resumeId:          process.env['RESUME_ID'] ?? '',
        resumeData:        null,
        interviewStage:    'applied',
        bucket:            process.env['S3_BUCKET'] ?? '',
        environment:       env.environment,
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
        startedAt:         new Date().toISOString(),
        userId:            env.userId,
    };

    try {
        await updatePipelineRun(pool, env.pipelineRunId, 'researching');
        await updateJobApplicationStatus(pool, env.applicationId, 'analysing');
        const research = await executeResearchAgent(ctx);

        await updatePipelineRun(pool, env.pipelineRunId, 'analysing');
        const analysis = await executeStrategistAgent(ctx, research.data);

        // Resume-builder persist (Option A): the Strategist already produced
        // the full tailored StructuredResumeData. Validate and persist to PG.
        const tailoredResumeData = analysis.data.tailoredResumeData ?? null;
        const archetype = analysis.data.archetypeSelection?.selectedArchetype ?? null;
        const persisted = tailoredResumeData
            ? await persistTailoredResume(pool, {
                applicationId:  env.applicationId,
                userId:         env.userId,
                pipelineId:     env.pipelineId,
                targetRole:     env.targetRole,
                archetype,
                tailoredResume: tailoredResumeData,
              })
            : null;

        await updateJobApplicationStatus(pool, env.applicationId, 'analysis-ready');
        await updatePipelineRun(pool, env.pipelineRunId, 'complete');

        console.log(JSON.stringify({
            event:         'strategist_pipeline_complete',
            pipelineRunId: env.pipelineRunId,
            applicationId: env.applicationId,
            resumeId:      persisted?.resumeId ?? null,
        }));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await updatePipelineRun(pool, env.pipelineRunId, 'failed', message)
            .catch(() => { /* swallow — already failing */ });
        await updateJobApplicationStatus(pool, env.applicationId, 'failed')
            .catch(() => { /* swallow — already failing */ });
        console.error(JSON.stringify({
            event:         'strategist_pipeline_failed',
            pipelineRunId: env.pipelineRunId,
            applicationId: env.applicationId,
            error:         message,
        }));
        throw err;
    } finally {
        await closePool();
    }
}

main().catch(() => process.exit(1));
