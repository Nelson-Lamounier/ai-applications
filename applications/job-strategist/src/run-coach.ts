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
import type { StrategistPipelineContext, StrategistAnalysisResult, StrategistResearchResult } from '@bedrock/shared';
import {
    bootstrapK8sObservability, pushFinalMetrics,
    RdsStagePrepOntologyRepository, toRoleFamily, toCompSeniority,
    loadStagePrepConstraints, buildStagePrepConstraintBlock,
} from '@bedrock/shared';
import { Counter, Histogram } from 'prom-client';

import { executeCoachAgent }   from './agents/coach-agent.js';
import { parseCoachEnv }       from './env-coach.js';
import { getPool, closePool }  from './lib/pg.js';
import {
    updatePipelineRun,
    persistCoachingContent,
} from './lib/pipeline-runs.js';

async function loadAnalysisAndResearch(
    pool: Pool,
    strategistPipelineRunId: string,
): Promise<{ analysis: StrategistAnalysisResult; research: StrategistResearchResult | null }> {
    const result = await pool.query<{
        metadata: { analysis?: StrategistAnalysisResult; research?: StrategistResearchResult } | null;
    }>(
        `SELECT metadata FROM pipeline_runs WHERE id = $1`,
        [strategistPipelineRunId],
    );
    const analysis = result.rows[0]?.metadata?.analysis;
    if (!analysis) {
        throw new Error(`No analysis found in pipeline_runs.metadata for id=${strategistPipelineRunId}`);
    }
    return { analysis, research: result.rows[0]?.metadata?.research ?? null };
}

// Same registry shape as run-pipeline.ts so dashboards can SUM across
// operations on `job_strategist_runs_total{operation=~"analyse|coach"}`.
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
    const env  = parseCoachEnv();
    const pool = getPool(env.pg);
    const start = process.hrtime.bigint();
    let outcome: 'success' | 'failed' = 'failed';

    try {
        const { analysis, research } = await loadAnalysisAndResearch(pool, env.strategistPipelineRunId);

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

        // Stage-prep ontology calibration (phone-screen and other supported stages).
        const repo = new RdsStagePrepOntologyRepository(pool);
        const seniority = toCompSeniority((research?.seniority ?? '').toLowerCase());
        const constraints = await loadStagePrepConstraints(repo, {
            targetCompany: env.targetCompany,
            roleFamily:    toRoleFamily(env.targetRole),
            stage:         env.interviewStage,
            seniority,
            region:        env.region,
            compTarget:    env.compTarget,
        });
        const dsaTopics = env.interviewStage.startsWith('technical')
            ? research?.dsaTopicCalibration?.likelyTopics?.map(t => t.displayName)
            : undefined;
        const constraintBlock = buildStagePrepConstraintBlock({ ...constraints, dsaTopics });

        const evidenceBlock = research ? [
            `Overall fit: ${research.overallFitRating ?? ''} — ${research.fitSummary ?? ''}`,
            `Experience signals: ${JSON.stringify(research.experienceSignals ?? {})}`,
            'Verified matches:',
            ...(research.verifiedMatches ?? []).map(m => `- ${m.skill} (${m.depth}) — ${m.sourceCitation}`),
        ].join('\n') : undefined;

        const coaching = await executeCoachAgent(ctx, analysis, constraintBlock, evidenceBlock);

        await persistCoachingContent(pool, {
            applicationId: env.applicationId,
            stageType:     env.interviewStage,
            coaching:      coaching.data,
        });

        await updatePipelineRun(pool, env.coachPipelineRunId, 'complete');
        outcome = 'success';

        log.info({
            coachPipelineRunId: env.coachPipelineRunId,
            applicationId:      env.applicationId,
            stage:              env.interviewStage,
        }, 'coach_pipeline_complete');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await updatePipelineRun(pool, env.coachPipelineRunId, 'failed', message)
            .catch(() => { /* swallow — already failing */ });
        log.error({
            coachPipelineRunId: env.coachPipelineRunId,
            applicationId:      env.applicationId,
            stage:              env.interviewStage,
            err: message,
        }, 'coach_pipeline_failed');
        throw err;
    } finally {
        await closePool();
        const duration = Number(process.hrtime.bigint() - start) / 1e9;
        strategistRuns.inc({ operation: 'coach', outcome });
        strategistDuration.observe({ operation: 'coach', outcome }, duration);
        await pushFinalMetrics(obs.registry, 'job-strategist', env.coachPipelineRunId);
        await obs.shutdown();
    }
}

main().catch(() => process.exit(1));
