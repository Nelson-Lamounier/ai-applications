/**
 * @format
 * Project Case-Study Generation K8s Job entrypoint.
 *
 * One run = one project. Loads context (project + commits + KB), runs
 * the case-study agent (Sonnet 4.6 default), verifies with grounding
 * mode='flag', persists the fanned-out sections.
 *
 * Status flow on pipeline_runs (type='case_study'):
 *
 *   queued → fetching_context → generating → grounding → persisting → complete
 *                                                                    ↘ failed
 *
 * Feature-flag gated by `projects.case_study.enabled`. Disabled runs
 * close out with metadata `{ skipped: 'feature_disabled' }`.
 *
 * Required env:
 *   CASE_STUDY_PIPELINE_RUN_ID, PROJECT_ID, USER_ID,
 *   PG_HOST/DATABASE/USER/PASSWORD. Optional: CASE_STUDY_MODEL,
 *   KB_VERSION, ENVIRONMENT.
 */
import { Counter, Gauge, Histogram } from 'prom-client';

import {
    BedrockGroundingVerifier,
    RedisExactCache,
    bedrockCaseStudyAgent,
    bootstrapK8sObservability,
    isFeatureEnabled,
    pushFinalMetrics,
    recordInvocationToRds,
    runCaseStudyOrchestration,
} from '@bedrock/shared';
import type { BasePipelineContext } from '@bedrock/shared';

import { parseCaseStudyEnv } from './env-case-study.js';
import { getPool, closePool } from './lib/pg.js';
import {
    updatePipelineRun,
    updatePipelineRunMetadata,
} from './lib/pipeline-runs.js';

const FEATURE_FLAG = 'projects.case_study.enabled';

const obs = bootstrapK8sObservability({ serviceName: 'project-case-study' });
const log = obs.logger;

const caseStudyRuns = new Counter({
    name:       'project_case_study_runs_total',
    help:       'Case-study Job runs by outcome.',
    labelNames: ['outcome'] as const,
    registers:  [obs.registry],
});
const caseStudyDuration = new Histogram({
    name:       'project_case_study_duration_seconds',
    help:       'End-to-end case-study Job duration in seconds.',
    labelNames: ['outcome'] as const,
    buckets:    [15, 30, 60, 120, 300, 600, 1200],
    registers:  [obs.registry],
});

// Cache effectiveness — unified counter shared with the read cache + other Jobs.
// See docs/adr/0001-cache-observability-prometheus-over-emf.md.
const CACHE_NAME = 'aigen:case_study';
const cacheRequests = new Counter({
    name:       'redis_cache_requests_total',
    help:       'Cache outcomes by cache name and result.',
    labelNames: ['cache', 'result'] as const,
    registers:  [obs.registry],
});
const cacheEnabled = new Gauge({
    name:       'redis_cache_enabled',
    help:       '1 if the cache is wired to a live Redis, 0 if fail-open disabled.',
    labelNames: ['cache'] as const,
    registers:  [obs.registry],
});
for (const result of ['hit', 'miss', 'error'] as const) cacheRequests.inc({ cache: CACHE_NAME, result }, 0);

async function main(): Promise<void> {
    const env  = parseCaseStudyEnv();
    const pool = getPool(env.pg);
    const start = process.hrtime.bigint();
    let outcome: 'success' | 'skipped' | 'failed' | 'cache_hit' = 'failed';

    try {
        const enabled = await isFeatureEnabled(pool, FEATURE_FLAG, env.userId);
        if (!enabled) {
            log.info({ userId: env.userId, flag: FEATURE_FLAG }, 'case-study disabled — skipping');
            await updatePipelineRunMetadata(pool, env.pipelineRunId, { skipped: 'feature_disabled' });
            await updatePipelineRun(pool, env.pipelineRunId, 'complete');
            outcome = 'skipped';
            return;
        }

        await updatePipelineRun(pool, env.pipelineRunId, 'fetching_context');

        const ctx: BasePipelineContext = {
            pipelineId:        env.pipelineRunId,
            environment:       env.environment,
            cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
            cumulativeCostUsd: 0,
            userId:            env.userId,
            onInvocationComplete: recordInvocationToRds(pool, 'project-case-study'),
        };

        const verifier = new BedrockGroundingVerifier({ mode: 'flag' });
        // Exact-key Redis cache. Reads REDIS_CACHE_* from env; disabled (and
        // therefore a no-op) when REDIS_CACHE_HOST is unset, so the job is
        // safe to deploy ahead of the cluster-side Redis wiring.
        const cache = RedisExactCache.fromEnvironment({
            metrics: {
                onHit:   () => cacheRequests.inc({ cache: CACHE_NAME, result: 'hit' }),
                onMiss:  () => cacheRequests.inc({ cache: CACHE_NAME, result: 'miss' }),
                onError: () => cacheRequests.inc({ cache: CACHE_NAME, result: 'error' }),
            },
        });
        cacheEnabled.set({ cache: CACHE_NAME }, cache.enabled ? 1 : 0);
        const kbTag = `${env.environment}:${env.kbVersion}:${env.model}`;

        await updatePipelineRun(pool, env.pipelineRunId, 'generating');

        const out = await runCaseStudyOrchestration(pool, {
            projectId:     env.projectId,
            pipelineRunId: env.pipelineRunId,
            model:         env.model,
            kbTag,
            agent:         bedrockCaseStudyAgent,
            verifier,
            cache,
            ctx,
        });

        await updatePipelineRun(
            pool,
            env.pipelineRunId,
            out.cacheHit ? 'persisting' : 'grounding',
        );

        await updatePipelineRunMetadata(pool, env.pipelineRunId, {
            cacheHit:                  out.cacheHit,
            inputHash:                 out.inputHash,
            stackItemsInserted:        out.persisted.stackItemsInserted,
            decisionsInserted:         out.persisted.decisionsInserted,
            highlightsInserted:        out.persisted.highlightsInserted,
            challengesInserted:        out.persisted.challengesInserted,
            resumeBulletSetsUpserted:  out.persisted.resumeBulletSetsUpserted,
            architectureUpserted:      out.persisted.architectureUpserted,
            depthMarkersUpserted:      out.persisted.depthMarkersUpserted,
            skippedSections:           out.persisted.skippedSections,
            commitsLoaded:             out.contextLoaded.context.commits.length,
            kbChunksLoaded:            out.contextLoaded.context.kbChunks.length,
            tokens:                    ctx.cumulativeTokens,
            costUsd:                   ctx.cumulativeCostUsd,
        });

        await updatePipelineRun(pool, env.pipelineRunId, 'complete');
        outcome = out.cacheHit ? 'cache_hit' : 'success';

        log.info({
            userId:               env.userId,
            projectId:            env.projectId,
            cacheHit:             out.cacheHit,
            decisionsInserted:    out.persisted.decisionsInserted,
            highlightsInserted:   out.persisted.highlightsInserted,
            challengesInserted:   out.persisted.challengesInserted,
            skippedSections:      out.persisted.skippedSections,
        }, 'case-study complete');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message, projectId: env.projectId }, 'case-study failed');
        try {
            await updatePipelineRun(pool, env.pipelineRunId, 'failed', message);
        } catch (innerErr) {
            log.error({ err: innerErr }, 'failed to mark pipeline_run failed');
        }
        throw err;
    } finally {
        const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
        caseStudyDuration.labels(outcome).observe(durationSec);
        caseStudyRuns.labels(outcome).inc();
        try {
            await pushFinalMetrics(obs.registry, 'project-case-study', env.pipelineRunId);
        } catch (err) {
            log.warn({ err }, 'pushFinalMetrics failed');
        }
        await closePool();
    }
}

main().catch((err) => {
    console.error('case-study Job failed:', err);
    process.exit(1);
});
