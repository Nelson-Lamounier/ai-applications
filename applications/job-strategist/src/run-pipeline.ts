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
import { bootstrapK8sObservability, pushFinalMetrics, BedrockGroundingVerifier, PgSemanticCache, PiiScrubber } from '@bedrock/shared';
import { Counter, Histogram } from 'prom-client';

import { executeResearchAgent, KB_CONTEXT_SEPARATOR } from './agents/research-agent.js';
import { executeStrategistAgent } from './agents/strategist-agent.js';
import { parseEnv }               from './env.js';
import { getPool, closePool }     from './lib/pg.js';
import {
    updatePipelineRun,
    updatePipelineRunMetadata,
    updateJobApplicationStatus,
    persistTailoredResume,
} from './lib/pipeline-runs.js';

/** Module-scoped grounding verifier — block mode replaces ungrounded analysis with fallback. */
const groundingVerifier = new BedrockGroundingVerifier({ mode: 'block' });

/** Shared Postgres+pgvector semantic response cache (fail-open). */
const semanticCache = PgSemanticCache.fromEnvironment();
/** Scrubs raw PII out of the JD before it is ever used as a cache key. */
const piiScrubber = new PiiScrubber();

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

/**
 * Build the semantic-cache kb_tag for a user. Fail-open: on any DB error
 * fall back to a model-only tag so the cache still partitions by model.
 */
async function cacheTagFor(pool: import('pg').Pool, userId: string): Promise<string> {
    const model = process.env['STRATEGIST_MODEL'] ?? 'default';
    try {
        const r = await pool.query<{ t: string }>(
            `SELECT COALESCE(MAX(last_synced_at)::text, '') || COALESCE((MAX(kb_quality_breakdown->>'version')), '') AS t FROM repo_sync_state WHERE user_id = $1`,
            [userId]);
        return `${r.rows[0]?.t ?? ''}:${model}`;
    } catch { return `:${model}`; }
}

export async function main(): Promise<void> {
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

        // ── Semantic cache short-circuit (fail-open) ──────────────────────
        // The JD is PII-scrubbed before it ever becomes the cache key so no
        // raw PII reaches the embedding model or the cache table. Any cache
        // failure degrades to a normal (uncached) run — never a hard-fail.
        // A hit reproduces the exact terminal run-state of a successful run.
        const cacheScope = `jobstrat:${env.userId}:${env.targetRole}:${env.targetCompany}`;
        // Fail-open: any throw from cacheTagFor degrades to a model-only tag so
        // the cache still partitions by model and the run never hard-fails.
        let cacheTag = `:${process.env['STRATEGIST_MODEL'] ?? 'default'}`;
        try { cacheTag = await cacheTagFor(pool, env.userId); } catch { /* fail-open: model-only tag */ }
        const jdForCache = piiScrubber.scrub(env.jobDescription).redacted;
        let cached: { hit: boolean; response?: unknown } = { hit: false };
        try {
            cached = (await semanticCache.get({ scope: cacheScope, kbTag: cacheTag, queryText: jdForCache })) ?? { hit: false };
        } catch (e) {
            log.warn({
                pipelineRunId: env.pipelineRunId,
                error: (e as Error).message,
            }, 'Semantic cache get failed — proceeding without cache');
            cached = { hit: false };
        }
        if (cached.hit && cached.response && typeof (cached.response as { analysisXml?: unknown }).analysisXml === 'string') {
            const cr = cached.response as {
                analysisXml: string;
                research: unknown;
                fitSummary: unknown;
                tailoredResumeData?: unknown;
                archetype?: string | null;
            };
            await updatePipelineRunMetadata(pool, env.pipelineRunId, {
                analysis: { analysisXml: cr.analysisXml, fitSummary: cr.fitSummary },
                research: cr.research,
            });
            // Reproduce the exact terminal state of a normal run: persist the
            // cached tailored resume so admin-api detail and the downstream
            // coach Job see a resume row. Older cached entries predate this
            // field — when absent, proceed without it (matches a run that
            // produced no resume). Mirrors the normal success-path call.
            if (cr.tailoredResumeData) {
                await persistTailoredResume(pool, {
                    applicationId:  env.applicationId,
                    userId:         env.userId,
                    pipelineId:     env.pipelineId,
                    targetRole:     env.targetRole,
                    archetype:      cr.archetype ?? null,
                    tailoredResume: cr.tailoredResumeData,
                });
            }
            await updateJobApplicationStatus(pool, env.applicationId, 'analysis-ready');
            await updatePipelineRun(pool, env.pipelineRunId, 'complete');
            outcome = 'success';
            log.info({
                pipelineRunId: env.pipelineRunId,
                applicationId: env.applicationId,
            }, 'strategist_pipeline_complete');
            return;
        }

        const research = await executeResearchAgent(ctx);

        await updatePipelineRun(pool, env.pipelineRunId, 'analysing');
        const analysis = await executeStrategistAgent(ctx, research.data);

        await updatePipelineRun(pool, env.pipelineRunId, 'persisting');

        // ── Grounding verification (block mode, fail-open) ─────────────────
        // Run after analysis is produced and KB context is available, before
        // any persistence so the verified (or fallback) text is what is stored.
        // Skip entirely when the KB returned no passages — block mode would
        // replace a perfectly good analysis with a one-line fallback.
        const contextChunks = (research.data.kbContext ?? '')
            .split(KB_CONTEXT_SEPARATOR)
            .filter((s: string) => s.trim().length > 0);
        let finalAnalysis = analysis.data.analysisXml;
        // Default non-NOT_GROUNDED → skipped (no verify) and verifier-threw
        // (fail-open) paths remain cacheable; only an explicit NOT_GROUNDED
        // fallback substitution must NOT be cached.
        let groundingStatus = 'GROUNDED';
        if (contextChunks.length > 0) {
            try {
                const g = await groundingVerifier.verify({
                    query: `${env.targetRole ?? ''} ${env.targetCompany ?? ''}`.trim(),
                    contextChunks,
                    answer: analysis.data.analysisXml,
                });
                groundingStatus = g.status;
                finalAnalysis = g.answer;
            } catch (e) {
                log.warn({
                    pipelineRunId: env.pipelineRunId,
                    error: (e as Error).message,
                }, 'Grounding verifier failed — keeping original analysis');
                strategistRuns.inc({ operation: 'analyse', outcome: 'grounding_error' });
            }
        } else {
            log.info({
                pipelineRunId: env.pipelineRunId,
            }, 'Grounding verification skipped — no KB context passages');
            strategistRuns.inc({ operation: 'analyse', outcome: 'grounding_skipped_no_context' });
        }

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

        // Stash both outputs on pipeline_runs.metadata so the admin-api detail
        // endpoint can serve research fields (fitSummary, matches, gaps, etc.)
        // and a downstream coach K8s Job can re-hydrate without re-running.
        // analysisXml is replaced by finalAnalysis (grounded or original on fail-open).
        await updatePipelineRunMetadata(pool, env.pipelineRunId, {
            analysis:  { ...analysis.data, analysisXml: finalAnalysis },
            research:  research.data,
        });

        // Store in the semantic cache (fire-and-forget, fail-open). Skip only
        // when grounding explicitly substituted the one-line fallback — a
        // skipped/fail-open verify keeps groundingStatus non-NOT_GROUNDED and
        // is therefore cacheable. The cache key is the PII-scrubbed JD.
        if (groundingStatus !== 'NOT_GROUNDED') {
            void semanticCache.put({
                scope:     cacheScope,
                kbTag:     cacheTag,
                queryText: jdForCache,
                response:  {
                    analysisXml:        finalAnalysis,
                    research:           research.data,
                    fitSummary:         research.data.fitSummary,
                    tailoredResumeData: analysis.data.tailoredResumeData,
                    archetype,
                },
            }).catch(() => { /* fail-open — cache write must never break the run */ });
        }

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

// Only auto-execute when run as the K8s Job entrypoint, not when imported by tests.
if (require.main === module) {
    main().catch(() => process.exit(1));
}
