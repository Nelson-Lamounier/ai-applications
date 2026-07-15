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
    OutputSanitiser,
    pushFinalMetrics,
    recordInvocationToRds,
    runClusteringOrchestration,
    withWorkflowTrace,
} from '@bedrock/shared';
import type { BasePipelineContext } from '@bedrock/shared';

import { parseClusteringEnv } from './env-clustering.js';
import { getPool, closePool } from './lib/db/pg.js';
import {
    updatePipelineRun,
    updatePipelineRunMetadata,
} from './lib/db/pipeline-runs.js';

const FEATURE_FLAG = 'projects.clustering.enabled';

const obs = bootstrapK8sObservability({ serviceName: 'project-clustering' });
const log = obs.logger;
const outputSanitiser = new OutputSanitiser();

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

function successfulOutcome(cacheHit: boolean): 'success' | 'cache_hit' {
    return cacheHit ? 'cache_hit' : 'success';
}

function clusteringModel(): string {
    return process.env.CLUSTERING_MODEL ?? 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
}

async function main(): Promise<void> {
    const env  = parseClusteringEnv();
    const pool = getPool(env.pg);
    const start = process.hrtime.bigint();
    const model = clusteringModel();
    let outcome: 'success' | 'skipped' | 'failed' | 'cache_hit' = 'failed';
    let traceId: string | undefined;
    const ctx: BasePipelineContext = {
        pipelineId:        env.pipelineRunId,
        environment:       env.environment,
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
        userId:            env.userId,
    };
    let terminalCacheHit = false;
    let terminalCounts = {
        digestsLoaded: 0,
        proposalsEmitted: 0,
        proposalsInserted: 0,
        componentsInserted: 0,
        linksInserted: 0,
        proposalsSkipped: 0,
        priorProposalsCleared: 0,
    };

    try {
        const enabled = await isFeatureEnabled(pool, FEATURE_FLAG, env.userId);
        if (!enabled) {
            outcome = 'skipped';
            await withWorkflowTrace({
                name: 'project.clustering.run',
                parentContext: obs.parentContext,
                attributes: {
                    'pipeline.run_id': env.pipelineRunId,
                    'workflow.type':   'clustering',
                },
            }, async (workflow) => {
                traceId = workflow.traceId;
                workflow.setAttributes({ 'workflow.outcome': outcome });
                await updatePipelineRunMetadata(pool, env.pipelineRunId, {
                    traceId,
                    skipped: 'feature_disabled',
                });
                await updatePipelineRun(pool, env.pipelineRunId, 'complete');
                log.info({
                    trace_id:       traceId,
                    pipelineRunId:  env.pipelineRunId,
                    outcome,
                    durationMs:     Number(process.hrtime.bigint() - start) / 1e6,
                    cacheHit:       terminalCacheHit,
                    model,
                    ...terminalCounts,
                    tokens:         ctx.cumulativeTokens,
                    costUsd:        0,
                    skipped:        'feature_disabled',
                }, 'project.clustering.complete');
            });
            return;
        }

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

        await withWorkflowTrace({
            name: 'project.clustering.run',
            parentContext: obs.parentContext,
            attributes: {
                'pipeline.run_id': env.pipelineRunId,
                'workflow.type':   'clustering',
            },
        }, async (workflow) => {
            traceId = workflow.traceId;
            await updatePipelineRunMetadata(pool, env.pipelineRunId, { traceId });
            ctx.onInvocationComplete = recordInvocationToRds(pool, 'project-clustering', { traceId });

            const out = await runClusteringOrchestration(pool, {
                userId:        env.userId,
                pipelineRunId: env.pipelineRunId,
                agent:         bedrockClusteringAgent,
                ctx,
                cache,
                kbTag:         env.environment,
                workflow,
                onStage: (stage) => updatePipelineRun(pool, env.pipelineRunId, stage),
            });
            terminalCacheHit = out.cacheHit;
            terminalCounts = {
                digestsLoaded: out.digests.length,
                proposalsEmitted: out.result.proposals.length,
                proposalsInserted: out.persisted.proposalsInserted,
                componentsInserted: out.persisted.componentsInserted,
                linksInserted: out.persisted.linksInserted,
                proposalsSkipped: out.persisted.proposalsSkipped,
                priorProposalsCleared: out.persisted.priorProposalsCleared,
            };

            const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
            await updatePipelineRunMetadata(pool, env.pipelineRunId, {
                traceId,
                cacheHit:               out.cacheHit,
                inputHash:              out.inputHash,
                model,
                ...terminalCounts,
                tokens:                 ctx.cumulativeTokens,
                costUsd:                ctx.cumulativeCostUsd,
                durationMs,
            });

            await updatePipelineRun(pool, env.pipelineRunId, 'complete');
            outcome = successfulOutcome(out.cacheHit);
            workflow.setAttributes({
                'workflow.outcome': outcome,
                'cache.hit':        out.cacheHit,
                'cost.usd':         ctx.cumulativeCostUsd,
            });
            log.info({
                trace_id:      traceId,
                pipelineRunId: env.pipelineRunId,
                outcome,
                durationMs,
                cacheHit:      out.cacheHit,
                model,
                ...terminalCounts,
                tokens:        ctx.cumulativeTokens,
                costUsd:       ctx.cumulativeCostUsd,
            }, 'project.clustering.complete');
        });
    } catch (err) {
        const rawMessage = err instanceof Error ? err.message : String(err);
        const errorMessage = outputSanitiser.sanitise(rawMessage).slice(0, 500);
        const errorClass = err instanceof Error ? err.name : 'Error';
        log.error({
            trace_id:      traceId,
            pipelineRunId: env.pipelineRunId,
            outcome:       'failed',
            durationMs:    Number(process.hrtime.bigint() - start) / 1e6,
            cacheHit:      terminalCacheHit,
            model,
            ...terminalCounts,
            tokens:        ctx.cumulativeTokens,
            costUsd:       ctx.cumulativeCostUsd,
            error: {
                class:   errorClass,
                message: errorMessage,
            },
        }, 'project.clustering.failed');
        try {
            await updatePipelineRun(pool, env.pipelineRunId, 'failed', errorMessage);
        } catch (innerErr) {
            const statusError = outputSanitiser.sanitise(
                innerErr instanceof Error ? innerErr.message : String(innerErr),
            ).slice(0, 500);
            log.error({
                trace_id: traceId,
                pipelineRunId: env.pipelineRunId,
                error: statusError,
            }, 'project.clustering.status_update_failed');
        }
        throw err;
    } finally {
        const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
        clusteringDuration.labels(outcome).observe(durationSec);
        clusteringRuns.labels(outcome).inc();
        try {
            await pushFinalMetrics(obs.registry, 'project-clustering', env.pipelineRunId);
        } catch (err) {
            const message = outputSanitiser.sanitise(err instanceof Error ? err.message : String(err));
            log.warn({ error: message }, 'pushFinalMetrics failed');
        }
        await obs.shutdown();
        await closePool();
    }
}

// Exit EXPLICITLY on success too. main() awaits its work and cleanup (obs.shutdown
// + closePool), but module-scope handles (Bedrock keep-alive sockets, pushgateway
// HTTP agent) keep the event loop alive, so the process would otherwise hang after
// success — leaving the K8s Job Running 0/1 until activeDeadlineSeconds force-kills
// it (~30min) and stamping a successful run as Failed. process.exit(0) ends it
// cleanly. Mirrors run-pipeline.ts.
main().then(
    () => process.exit(0),
    () => process.exit(1),
);
