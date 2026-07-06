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
    RedisExactCache,
    bedrockCaseStudyAgent,
    bedrockSystemTourAgent,
    bootstrapK8sObservability,
    isFeatureEnabled,
    OutputSanitiser,
    pushFinalMetrics,
    recordInvocationToRds,
    runCaseStudyOrchestration,
    runSystemTour,
    withWorkflowTrace,
    RdsSystemTourRepository,
    loadRepoRoleSignals,
    recomputeConfirmedProjectComponents,
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
const outputSanitiser = new OutputSanitiser();

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

/**
 * Refresh a confirmed project's components from current code-grounded signals,
 * inside its own transaction with RLS context. Best-effort — logs and returns
 * on any failure so it can never fail the case-study generation.
 */
async function refreshProjectComponentsBestEffort(
    pool: Awaited<ReturnType<typeof getPool>>,
    userId: string,
    projectId: string,
): Promise<void> {
    try {
        const roleSignals = await loadRepoRoleSignals(pool, userId);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            const refreshed = await recomputeConfirmedProjectComponents(client, userId, roleSignals, { projectId });
            await client.query('COMMIT');
            log.info({ projectId, ...refreshed }, 'refreshed components from grounded signals');
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch (err) {
        log.warn({ err: err instanceof Error ? err.message : String(err), projectId }, 'component refresh skipped');
    }
}

async function main(): Promise<void> {
    const env  = parseCaseStudyEnv();
    const pool = getPool(env.pg);
    const start = process.hrtime.bigint();
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
    let terminalGenerationMode: 'unknown' | 'cache_hit' | 'refine' | 'full' = 'unknown';
    let terminalCounts = {
        stackItemsInserted: 0,
        stackItemsPruned: 0,
        decisionsInserted: 0,
        decisionsPruned: 0,
        highlightsInserted: 0,
        highlightsPruned: 0,
        challengesInserted: 0,
        challengesPruned: 0,
    };
    let terminalGrounding = {
        checked: 0,
        grounded: 0,
        flagged: 0,
        notVerified: 0,
    };

    try {
        const enabled = await isFeatureEnabled(pool, FEATURE_FLAG, env.userId);
        if (!enabled) {
            outcome = 'skipped';
            await withWorkflowTrace({
                name: 'project.case_study.run',
                parentContext: obs.parentContext,
                attributes: {
                    'pipeline.run_id': env.pipelineRunId,
                    'project.id':      env.projectId,
                    'workflow.type':   'case_study',
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
                    projectId:      env.projectId,
                    outcome,
                    durationMs:     Number(process.hrtime.bigint() - start) / 1e6,
                    cacheHit:       terminalCacheHit,
                    generationMode: terminalGenerationMode,
                    ...terminalCounts,
                    grounding:      terminalGrounding,
                    tokens:         ctx.cumulativeTokens,
                    costUsd:        0,
                    skipped:        'feature_disabled',
                }, 'project.case_study.complete');
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
        const kbTag = `${env.environment}:${env.kbVersion}:${env.model}`;

        await withWorkflowTrace({
            name: 'project.case_study.run',
            parentContext: obs.parentContext,
            attributes: {
                'pipeline.run_id': env.pipelineRunId,
                'project.id':      env.projectId,
                'workflow.type':   'case_study',
            },
        }, async (workflow) => {
            traceId = workflow.traceId;
            await updatePipelineRunMetadata(pool, env.pipelineRunId, { traceId });
            ctx.onInvocationComplete = recordInvocationToRds(pool, 'project-case-study', {
                projectId: env.projectId,
                traceId,
            });

            // Refresh THIS project's components from current code-grounded signals
            // (archetype/fileClass) before generating — so the case study reads
            // role-correct structure (e.g. a GitOps-infra repo no longer filed as
            // 'shared'). Best-effort: a refresh failure must not fail the case study.
            await refreshProjectComponentsBestEffort(pool, env.userId, env.projectId);

            // Incremental refine by default: when the project already has a
            // completed case study, the agent updates it (preserving grounded rows)
            // instead of regenerating from scratch. First-ever generation falls back
            // to full. Set CASE_STUDY_DISABLE_REFINE=true to force a full rewrite.
            const refine = process.env.CASE_STUDY_DISABLE_REFINE !== 'true';

            const out = await runCaseStudyOrchestration(pool, {
                projectId:     env.projectId,
                pipelineRunId: env.pipelineRunId,
                model:         env.model,
                kbTag,
                agent:         bedrockCaseStudyAgent,
                cache,
                ctx,
                refine,
                workflow,
                onStage: (stage) => updatePipelineRun(pool, env.pipelineRunId, stage),
            });
            terminalCacheHit = out.cacheHit;
            terminalGenerationMode = out.cacheHit ? 'cache_hit' : out.refined ? 'refine' : 'full';
            terminalCounts = {
                stackItemsInserted: out.persisted.stackItemsInserted,
                stackItemsPruned: out.persisted.stackItemsPruned,
                decisionsInserted: out.persisted.decisionsInserted,
                decisionsPruned: out.persisted.decisionsPruned,
                highlightsInserted: out.persisted.highlightsInserted,
                highlightsPruned: out.persisted.highlightsPruned,
                challengesInserted: out.persisted.challengesInserted,
                challengesPruned: out.persisted.challengesPruned,
            };
            terminalGrounding = out.grounding;

            // S7b: generate the project's system-tour walkthrough from the fresh case study.
            // Fail-open — the case study is already persisted; a tour failure must not fail the job.
            let systemTourGenerated = false;
            try {
                await workflow.stage('project.case_study.system_tour', {}, async () => {
                    await runSystemTour({
                        projectId: env.projectId,
                        userId:    env.userId,
                        caseStudy: out.caseStudy,
                        agent:     bedrockSystemTourAgent,
                        repo:      new RdsSystemTourRepository(pool),
                        ctx,
                    });
                });
                systemTourGenerated = true;
            } catch (err) {
                const message = outputSanitiser.sanitise(err instanceof Error ? err.message : String(err));
                log.warn({
                    trace_id: traceId,
                    pipelineRunId: env.pipelineRunId,
                    projectId: env.projectId,
                    error: message,
                }, 'project.case_study.system_tour_failed');
            }

            const generationMode = terminalGenerationMode;
            const totalCostUsd = ctx.cumulativeCostUsd;

            await updatePipelineRunMetadata(pool, env.pipelineRunId, {
                traceId,
                cacheHit:                  out.cacheHit,
                refined:                   out.refined,
                generationMode,
                inputHash:                 out.inputHash,
                stackItemsInserted:        out.persisted.stackItemsInserted,
                stackItemsPruned:          out.persisted.stackItemsPruned,
                decisionsInserted:         out.persisted.decisionsInserted,
                decisionsPruned:           out.persisted.decisionsPruned,
                highlightsInserted:        out.persisted.highlightsInserted,
                highlightsPruned:          out.persisted.highlightsPruned,
                challengesInserted:        out.persisted.challengesInserted,
                challengesPruned:          out.persisted.challengesPruned,
                resumeBulletSetsUpserted:  out.persisted.resumeBulletSetsUpserted,
                architectureUpserted:      out.persisted.architectureUpserted,
                depthMarkersUpserted:      out.persisted.depthMarkersUpserted,
                skippedSections:           out.persisted.skippedSections,
                systemTourGenerated,
                groundingChecked:          out.grounding.checked,
                groundingGrounded:         out.grounding.grounded,
                groundingFlagged:          out.grounding.flagged,
                groundingNotVerified:      out.grounding.notVerified,
                commitsLoaded:             out.contextLoaded.context.commits.length,
                kbChunksLoaded:            out.contextLoaded.context.kbChunks.length,
                tokens:                    ctx.cumulativeTokens,
                generationCostUsd:         ctx.cumulativeCostUsd,
                totalCostUsd,
                costUsd:                   totalCostUsd,
            });

            await updatePipelineRun(pool, env.pipelineRunId, 'complete');
            outcome = out.cacheHit ? 'cache_hit' : 'success';

            const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
            workflow.setAttributes({
                'workflow.outcome': outcome,
                'cache.hit':        out.cacheHit,
                'generation.mode':  generationMode,
                'cost.usd':         totalCostUsd,
            });
            log.info({
                trace_id:             traceId,
                pipelineRunId:        env.pipelineRunId,
                projectId:            env.projectId,
                outcome,
                durationMs,
                cacheHit:             out.cacheHit,
                generationMode,
                stackItemsInserted:   out.persisted.stackItemsInserted,
                stackItemsPruned:     out.persisted.stackItemsPruned,
                decisionsInserted:    out.persisted.decisionsInserted,
                decisionsPruned:      out.persisted.decisionsPruned,
                highlightsInserted:   out.persisted.highlightsInserted,
                highlightsPruned:     out.persisted.highlightsPruned,
                challengesInserted:   out.persisted.challengesInserted,
                challengesPruned:     out.persisted.challengesPruned,
                grounding:            out.grounding,
                tokens:               ctx.cumulativeTokens,
                costUsd:              totalCostUsd,
                systemTourGenerated,
                skippedSections:      out.persisted.skippedSections,
            }, 'project.case_study.complete');
        });
    } catch (err) {
        const rawMessage = err instanceof Error ? err.message : String(err);
        const errorMessage = outputSanitiser.sanitise(rawMessage).slice(0, 500);
        const errorClass = err instanceof Error ? err.name : 'Error';
        const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
        log.error({
            trace_id:      traceId,
            pipelineRunId: env.pipelineRunId,
            projectId:     env.projectId,
            outcome:       'failed',
            durationMs,
            cacheHit:      terminalCacheHit,
            generationMode: terminalGenerationMode,
            ...terminalCounts,
            grounding:      terminalGrounding,
            tokens:         ctx.cumulativeTokens,
            costUsd:        ctx.cumulativeCostUsd,
            error: {
                class:   errorClass,
                message: errorMessage,
            },
        }, 'project.case_study.failed');
        try {
            await updatePipelineRun(pool, env.pipelineRunId, 'failed', errorMessage);
        } catch (innerErr) {
            const statusError = outputSanitiser.sanitise(
                innerErr instanceof Error ? innerErr.message : String(innerErr),
            ).slice(0, 500);
            log.error({
                trace_id: traceId,
                pipelineRunId: env.pipelineRunId,
                projectId: env.projectId,
                error: statusError,
            }, 'project.case_study.status_update_failed');
        }
        throw err;
    } finally {
        const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
        caseStudyDuration.labels(outcome).observe(durationSec);
        caseStudyRuns.labels(outcome).inc();
        try {
            await pushFinalMetrics(obs.registry, 'project-case-study', env.pipelineRunId);
        } catch (err) {
            const message = outputSanitiser.sanitise(err instanceof Error ? err.message : String(err));
            log.warn({ error: message }, 'pushFinalMetrics failed');
        }
        await obs.shutdown();
        await closePool();
    }
}

// Exit EXPLICITLY on success too. main() awaits its work, closes the pg pool,
// and shuts down observability — but module-scope handles (the Bedrock client's
// keep-alive sockets, the Redis cache connection, the pushgateway HTTP agent)
// keep the event loop alive, so the process would otherwise hang after logging
// success — leaving the K8s Job Running 0/1 until activeDeadlineSeconds
// force-kills it (~30min) and stamping a successful run as Failed.
// process.exit(0) ends it cleanly. Mirrors run-pipeline.ts.
main().then(
    () => process.exit(0),
    () => process.exit(1),
);
