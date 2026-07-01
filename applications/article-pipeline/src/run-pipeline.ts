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
import type { PipelineContext, QaValidationResult } from '@bedrock/shared';
import { bootstrapK8sObservability, pushFinalMetrics, PiiScrubber, BedrockGroundingVerifier, emitEmfMetric, recordInvocationToRds } from '@bedrock/shared';
import { Counter, Histogram } from 'prom-client';

import { executeResearchAgent } from './agents/research-agent.js';
import { executeWriterAgent }   from './agents/writer-agent.js';
import { executeQaAgent }       from './agents/qa-agent.js';
import { parseEnv }             from './env.js';
import { getPool, closePool }   from './lib/pg.js';
import {
    updatePipelineRun,
    updatePipelineRunMetadata,
    persistArticle,
} from './lib/pipeline-runs.js';

const piiScrubber = new PiiScrubber();
const groundingVerifier = new BedrockGroundingVerifier({ mode: 'flag' });
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

/**
 * Build the pipeline_runs.metadata payload from the QA verdict (+ grounding).
 * QA issues live per-dimension; flatten them (tagged with their dimension) into
 * one reviewable list so the admin review UI can show WHY an article needs
 * revision, not just a score.
 */
function buildRunMetadata(
    qa: QaValidationResult,
    groundingMeta: object | undefined,
): Record<string, unknown> {
    const issues = Object.entries(qa.dimensions).flatMap(([dimension, dim]) =>
        dim.issues.map((issue) => ({ dimension, ...issue })),
    );
    const meta: Record<string, unknown> = {
        qa: {
            overallScore:       qa.overallScore,
            recommendation:     qa.recommendation,
            confidenceOverride: qa.confidenceOverride,
            summary:            qa.summary,
            dimensionScores:    Object.fromEntries(
                Object.entries(qa.dimensions).map(([k, v]) => [k, v.score]),
            ),
            issues,
        },
    };
    if (groundingMeta !== undefined) {
        meta['grounding'] = groundingMeta;
    }
    return meta;
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
        onInvocationComplete: recordInvocationToRds(pool, 'article-pipeline'),
    };

    try {
        await updatePipelineRun(pool, env.pipelineRunId, 'researching');
        const research = await timed('research', () => executeResearchAgent(ctx, pool));

        // Fold a structured topic brief (if the article-job carried one) into the
        // research result: its problem/angle seeds the author direction when the
        // draft did not, and its author-confirmed verified metrics reach the
        // Writer's authoritative "Verified Metrics" block (Gap 3). No brief → the
        // research result is used unchanged (draft-only path).
        const brief = env.articleBrief;
        const researchData = brief
            ? {
                ...research.data,
                verifiedMetrics: brief.verifiedMetrics ?? research.data.verifiedMetrics,
                authorDirection: research.data.authorDirection
                    || [brief.problem, brief.angle].filter(Boolean).join(' — '),
              }
            : research.data;

        await updatePipelineRun(pool, env.pipelineRunId, 'writing');
        const writer = await timed('writing', () => executeWriterAgent(ctx, researchData));

        await updatePipelineRun(pool, env.pipelineRunId, 'qa');
        const qa = await timed('qa', () => executeQaAgent(
            ctx,
            writer.data,
            researchData.technicalFacts,
            researchData.mode,
        ));

        // Grounding check (flag mode) — always-on, never blocks persist.
        // Runs post-QA, pre-persist. Fail-open: any verifier error is logged and
        // ignored so the article always proceeds to 'review'.
        const scrubbedContent = piiScrubber.scrub(writer.data.content).redacted;
        let groundingMeta: Pick<Awaited<ReturnType<typeof groundingVerifier.verify>>, 'status' | 'reason' | 'ungroundedClaims'> | undefined;
        try {
            const g = await groundingVerifier.verify({
                query:        `${env.slug} ${research.data.authorDirection ?? ''}`.trim().slice(0, 500),
                contextChunks: (research.data.kbPassages ?? []).map((p) => p.text),
                answer:       scrubbedContent,
            }, env.userId ? { pool, userId: env.userId } : undefined);
            emitEmfMetric('ArticlePipeline', { Stage: 'grounding', Status: g.status }, [
                { name: 'GroundingChecked',      value: 1,                                     unit: 'Count' },
                { name: 'GroundingFailed',       value: g.status === 'NOT_GROUNDED' ? 1 : 0,  unit: 'Count' },
                { name: 'UngroundedClaimCount',  value: g.ungroundedClaims.length,             unit: 'Count' },
            ]);
            groundingMeta = { status: g.status, reason: g.reason, ungroundedClaims: [...g.ungroundedClaims] };
        } catch (e) {
            emitEmfMetric('ArticlePipeline', { Stage: 'grounding', Status: 'ERROR' }, [
                { name: 'GroundingError', value: 1, unit: 'Count' },
            ]);
            log.warn({
                pipelineRunId: env.pipelineRunId,
                slug:          env.slug,
                error:         (e as Error).message,
            }, 'Grounding verifier failed — proceeding');
        }

        // Final persist — write the rendered MDX back to platform RDS.
        // Use scrubbedContent computed above; grounding flag mode never alters it.
        // Write the Writer's title/excerpt/tags into their own columns so the
        // portfolio (public-api) and admin dashboard render the real SEO metadata,
        // not the placeholder slug. The DB slug (env.slug) stays authoritative;
        // the Writer's frontmatter slug is intentionally not used for the URL.
        await persistArticle(pool, env.slug, scrubbedContent, env.foundationModel, {
            title:   writer.data.metadata.title,
            excerpt: writer.data.metadata.description,
            tags:    writer.data.metadata.tags,
        });

        // Attach QA + grounding results to pipeline_runs.metadata (JSONB — no
        // migration needed) so the review UI can show WHY an article needs
        // revision, not just a score.
        await updatePipelineRunMetadata(
            pool,
            env.pipelineRunId,
            buildRunMetadata(qa.data, groundingMeta),
        );

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
