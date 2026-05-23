/**
 * @format
 * Project Clustering K8s Job entrypoint.
 *
 * One run = one user. Reads digests from RDS, computes deterministic
 * signals, calls the clustering agent (Haiku 4.5), persists the proposals
 * to the projects table.
 *
 * Status flow on pipeline_runs (type='clustering'):
 *
 *   queued → signals_extracting → analysing → persisting → complete
 *                                                          ↘ failed
 *
 * Feature-flag gated by `projects.clustering.enabled`. A failing flag check
 * is logged and the run is marked complete with metadata
 * `{ skipped: 'feature_disabled' }` — admin-api / onboarding can dispatch
 * the Job idempotently without knowing whether the gate is open.
 *
 * Required env (parsed by env-clustering.ts):
 *   CLUSTERING_PIPELINE_RUN_ID, USER_ID, PG_HOST, PG_DATABASE,
 *   PG_USER, PG_PASSWORD, optional PG_PORT, ENVIRONMENT.
 */
import { Counter, Gauge, Histogram } from 'prom-client';

import {
    RedisExactCache,
    bedrockClusteringAgent,
    bootstrapK8sObservability,
    isFeatureEnabled,
    pushFinalMetrics,
    runClusteringOrchestration,
} from '@bedrock/shared';
import type { BasePipelineContext } from '@bedrock/shared';

import { parseClusteringEnv } from './env-clustering.js';
import { getPool, closePool } from './lib/pg.js';
import {
    updatePipelineRun,
    updatePipelineRunMetadata,
} from './lib/pipeline-runs.js';

const FEATURE_FLAG = 'projects.clustering.enabled';

const obs = bootstrapK8sObservability({ serviceName: 'project-clustering' });
const log = obs.logger;

const clusteringRuns = new Counter({
    name:       'project_clustering_runs_total',
    help:       'Project clustering Job runs by outcome.',
    labelNames: ['outcome'] as const,
    registers:  [obs.registry],
});
const clusteringDuration = new Histogram({
    name:       'project_clustering_duration_seconds',
    help:       'End-to-end project clustering Job duration in seconds.',
    labelNames: ['outcome'] as const,
    buckets:    [5, 15, 30, 60, 120, 300, 600],
    registers:  [obs.registry],
});

// Cache effectiveness — unified counter shared with the read cache + other Jobs.
// See docs/adr/0001-cache-observability-prometheus-over-emf.md.
const CACHE_NAME = 'aigen:clustering';
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
// Seed result series so panels render 0 instead of "No data".
for (const result of ['hit', 'miss', 'error'] as const) cacheRequests.inc({ cache: CACHE_NAME, result }, 0);

async function main(): Promise<void> {
    const env  = parseClusteringEnv();
    const pool = getPool(env.pg);
    const start = process.hrtime.bigint();
    let outcome: 'success' | 'skipped' | 'failed' | 'cache_hit' = 'failed';

    try {
        const enabled = await isFeatureEnabled(pool, FEATURE_FLAG, env.userId);
        if (!enabled) {
            log.info({ userId: env.userId, flag: FEATURE_FLAG }, 'clustering disabled — skipping');
            await updatePipelineRunMetadata(pool, env.pipelineRunId, { skipped: 'feature_disabled' });
            await updatePipelineRun(pool, env.pipelineRunId, 'complete');
            outcome = 'skipped';
            return;
        }

        await updatePipelineRun(pool, env.pipelineRunId, 'signals_extracting');

        const ctx: BasePipelineContext = {
            pipelineId:        env.pipelineRunId,
            environment:       env.environment,
            cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
            cumulativeCostUsd: 0,
        };

        await updatePipelineRun(pool, env.pipelineRunId, 'analysing');

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

        const out = await runClusteringOrchestration(pool, {
            userId:        env.userId,
            pipelineRunId: env.pipelineRunId,
            agent:         bedrockClusteringAgent,
            ctx,
            cache,
            kbTag:         env.environment,
        });

        await updatePipelineRun(pool, env.pipelineRunId, 'persisting');

        await updatePipelineRunMetadata(pool, env.pipelineRunId, {
            cacheHit:               out.cacheHit,
            inputHash:              out.inputHash,
            digestsLoaded:          out.digests.length,
            proposalsEmitted:       out.result.proposals.length,
            proposalsInserted:      out.persisted.proposalsInserted,
            componentsInserted:     out.persisted.componentsInserted,
            linksInserted:          out.persisted.linksInserted,
            proposalsSkipped:       out.persisted.proposalsSkipped,
            priorProposalsCleared:  out.persisted.priorProposalsCleared,
            tokens:                 ctx.cumulativeTokens,
            costUsd:                ctx.cumulativeCostUsd,
        });

        await updatePipelineRun(pool, env.pipelineRunId, 'complete');
        outcome = out.cacheHit ? 'cache_hit' : 'success';

        log.info({
            userId:                env.userId,
            digests:               out.digests.length,
            proposalsInserted:     out.persisted.proposalsInserted,
            proposalsSkipped:      out.persisted.proposalsSkipped,
            priorProposalsCleared: out.persisted.priorProposalsCleared,
        }, 'clustering complete');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message, userId: env.userId }, 'clustering failed');
        try {
            await updatePipelineRun(pool, env.pipelineRunId, 'failed', message);
        } catch (innerErr) {
            log.error({ err: innerErr }, 'failed to mark pipeline_run failed');
        }
        throw err;
    } finally {
        const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
        clusteringDuration.labels(outcome).observe(durationSec);
        clusteringRuns.labels(outcome).inc();
        try {
            await pushFinalMetrics(obs.registry, 'project-clustering', env.pipelineRunId);
        } catch (err) {
            log.warn({ err }, 'pushFinalMetrics failed');
        }
        await closePool();
    }
}

main().catch((err) => {
     
    console.error('clustering Job failed:', err);
    process.exit(1);
});
