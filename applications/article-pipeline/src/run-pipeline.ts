/**
 * @format
 * Article pipeline K8s Job entrypoint — replaces the Trigger/Research/Writer/QA
 * Lambda chain orchestrated by Step Functions.
 *
 * Status transitions persisted in platform RDS pipeline_runs:
 *   queued → researching → writing → qa → complete (or failed at any step)
 *
 * On QA pass the rendered draft is persisted to platform RDS articles.status =
 * 'review'. The admin-api owns the eventual transition to 'published'.
 */
import type { PipelineContext } from '@bedrock/shared';
import { bootstrapK8sObservability, pushFinalMetrics } from '@bedrock/shared';
import { Counter, Histogram } from 'prom-client';

import { executeResearchAgent } from './agents/research-agent.js';
import { executeWriterAgent }   from './agents/writer-agent.js';
import { executeQaAgent }       from './agents/qa-agent.js';
import { parseEnv }             from './env.js';
import { getPool, closePool }   from './lib/pg.js';
import {
    updatePipelineRun,
    persistArticle,
} from './lib/pipeline-runs.js';

const obs = bootstrapK8sObservability({ serviceName: 'article-pipeline' });
const log = obs.logger;

const pipelineRuns = new Counter({
    name:       'article_pipeline_runs_total',
    help:       'Article pipeline Job runs by terminal outcome.',
    labelNames: ['outcome'] as const,
    registers:  [obs.registry],
});
const pipelineDuration = new Histogram({
    name:       'article_pipeline_duration_seconds',
    help:       'End-to-end pipeline duration in seconds.',
    labelNames: ['outcome'] as const,
    buckets:    [10, 30, 60, 120, 300, 600, 1200, 1800],
    registers:  [obs.registry],
});
const stepDuration = new Histogram({
    name:       'article_pipeline_step_duration_seconds',
    help:       'Per-stage duration (research / writing / qa).',
    labelNames: ['step'] as const,
    buckets:    [1, 5, 15, 30, 60, 120, 300, 600],
    registers:  [obs.registry],
});

async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
    const t0 = process.hrtime.bigint();
    try { return await fn(); }
    finally {
        stepDuration.observe({ step }, Number(process.hrtime.bigint() - t0) / 1e9);
    }
}

async function main(): Promise<void> {
    const env  = parseEnv();
    const pool = getPool(env.pg);
    const start = process.hrtime.bigint();
    let outcome: 'success' | 'failed' = 'failed';

    const ctx: PipelineContext = {
        pipelineId:        env.pipelineId,
        userId:            env.userId,
        slug:              env.slug,
        sourceKey:         env.s3SourceKey,
        bucket:            env.s3Bucket,
        environment:       env.environment,
        version:           Number.parseInt(process.env['PIPELINE_VERSION'] ?? '1', 10),
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
        retryAttempt:      0,
        startedAt:         new Date().toISOString(),
    };

    try {
        await updatePipelineRun(pool, env.pipelineRunId, 'researching');
        const research = await timed('research', () => executeResearchAgent(ctx, pool));

        await updatePipelineRun(pool, env.pipelineRunId, 'writing');
        const writer = await timed('writing', () => executeWriterAgent(ctx, research.data));

        await updatePipelineRun(pool, env.pipelineRunId, 'qa');
        const qa = await timed('qa', () => executeQaAgent(
            ctx,
            writer.data,
            research.data.technicalFacts,
            research.data.mode,
        ));

        // Final persist — write the rendered MDX back to platform RDS.
        await persistArticle(pool, env.slug, writer.data.content);

        await updatePipelineRun(pool, env.pipelineRunId, 'complete');
        outcome = 'success';

        log.info({
            pipelineRunId: env.pipelineRunId,
            slug:          env.slug,
            qaScore:       qa.data.overallScore,
            recommendation: qa.data.recommendation,
        }, 'article_pipeline_complete');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await updatePipelineRun(pool, env.pipelineRunId, 'failed', message)
            .catch(() => { /* swallow — already failing */ });
        log.error({
            pipelineRunId: env.pipelineRunId,
            slug:          env.slug,
            err: message,
        }, 'article_pipeline_failed');
        throw err;
    } finally {
        await closePool();
        const duration = Number(process.hrtime.bigint() - start) / 1e9;
        pipelineRuns.inc({ outcome });
        pipelineDuration.observe({ outcome }, duration);
        await pushFinalMetrics(obs.registry, 'article-pipeline', env.pipelineRunId);
        await obs.shutdown();
    }
}

main().catch(() => process.exit(1));
