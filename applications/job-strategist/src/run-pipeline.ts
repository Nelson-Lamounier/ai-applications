/**
 * @format
 * Strategist analysis K8s Job entrypoint — replaces the
 * Trigger / Research / Strategist / Resume-builder / Analysis-persist Lambda
 * chain orchestrated by Step Functions.
 *
 * Status transitions persisted in platform RDS pipeline_runs:
 *   queued → researching → analysing → persisting → complete (or failed at any step)
 *
 * Parallel job_applications.kanban_status lifecycle:
 *   <prior> → analysing → analysis-ready (or failed)
 *
 * On Strategist success the Strategist-authored tailored StructuredResumeData
 * (Option A) is validated and persisted to platform RDS resumes.
 */
import type { StrategistPipelineContext } from '@bedrock/shared';
import { bootstrapK8sObservability, pushFinalMetrics } from '@bedrock/shared';
import { Counter, Histogram } from 'prom-client';

import { executeResearchAgent }   from './agents/research-agent.js';
import { executeStrategistAgent } from './agents/strategist-agent.js';
import { parseEnv }               from './env.js';
import { getPool, closePool }     from './lib/pg.js';
import {
    updatePipelineRun,
    updatePipelineRunMetadata,
    updateJobApplicationStatus,
    persistTailoredResume,
} from './lib/pipeline-runs.js';

// Shared registry across both run-pipeline (analyse) and run-coach so
// dashboard rollups can be done service-wide.
const obs = bootstrapK8sObservability({ serviceName: 'job-strategist' });
const log = obs.logger;

const strategistRuns = new Counter({
    name:       'job_strategist_runs_total',
    help:       'Strategist Job runs by operation and outcome.',
    labelNames: ['operation', 'outcome'] as const,
    registers:  [obs.registry],
});
const strategistDuration = new Histogram({
    name:       'job_strategist_duration_seconds',
    help:       'End-to-end Strategist Job duration in seconds.',
    labelNames: ['operation', 'outcome'] as const,
    buckets:    [10, 30, 60, 120, 300, 600, 1200, 1800],
    registers:  [obs.registry],
});

async function main(): Promise<void> {
    const env  = parseEnv();
    const pool = getPool(env.pg);
    const start = process.hrtime.bigint();
    let outcome: 'success' | 'failed' = 'failed';

    // Fetch the user's active resume from PG if RESUME_ID is provided.
    // Done here rather than inside the research agent so the structured JSON
    // is available to the strategist agent as Phase 1 input without an
    // extra PG round-trip mid-pipeline.
    let resumeData: unknown = null;
    if (env.resumeId) {
        const result = await pool.query<{ content_json: unknown }>(
            `SELECT content_json FROM resumes WHERE id = $1 AND (user_id = $2 OR user_id IS NULL)`,
            [env.resumeId, env.userId],
        );
        resumeData = result.rows[0]?.content_json ?? null;
        if (resumeData) {
            log.info({ pipelineRunId: env.pipelineRunId, resumeId: env.resumeId }, 'resume_loaded_from_pg');
        } else {
            log.warn({ pipelineRunId: env.pipelineRunId, resumeId: env.resumeId }, 'resume_not_found_in_pg');
        }
    }

    // Construct the StrategistPipelineContext required by the agents.
    //
    // Notes on field provenance:
    //  - resumeId / resumeData: resolved above via PG lookup when RESUME_ID is
    //    provided by admin-api at dispatch time.
    //  - bucket: artefact bucket for any S3 offload paths in the agents.
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
        resumeId:          env.resumeId,
        resumeData:        resumeData as import('@bedrock/shared').StructuredResumeData | null,
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

        await updatePipelineRun(pool, env.pipelineRunId, 'persisting');

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

        // Stash the analysis on pipeline_runs.metadata so a downstream coach
        // K8s Job can re-hydrate it without re-running Research+Strategist.
        await updatePipelineRunMetadata(pool, env.pipelineRunId, { analysis: analysis.data });

        await updateJobApplicationStatus(pool, env.applicationId, 'analysis-ready');
        await updatePipelineRun(pool, env.pipelineRunId, 'complete');
        outcome = 'success';

        log.info({
            pipelineRunId: env.pipelineRunId,
            applicationId: env.applicationId,
            resumeId:      persisted?.resumeId ?? null,
        }, 'strategist_pipeline_complete');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await updatePipelineRun(pool, env.pipelineRunId, 'failed', message)
            .catch(() => { /* swallow — already failing */ });
        await updateJobApplicationStatus(pool, env.applicationId, 'failed')
            .catch(() => { /* swallow — already failing */ });
        log.error({
            pipelineRunId: env.pipelineRunId,
            applicationId: env.applicationId,
            err: message,
        }, 'strategist_pipeline_failed');
        throw err;
    } finally {
        await closePool();
        const duration = Number(process.hrtime.bigint() - start) / 1e9;
        strategistRuns.inc({ operation: 'analyse', outcome });
        strategistDuration.observe({ operation: 'analyse', outcome }, duration);
        await pushFinalMetrics(obs.registry, 'job-strategist', env.pipelineRunId);
        await obs.shutdown();
    }
}

main().catch(() => process.exit(1));
