/**
 * @format
 * Ingestion K8s Job entrypoint — runs as a one-shot pod (not a Lambda).
 *
 * Replaces the 3-Lambda chain (Trigger → Fetcher → Worker + S3 staging) with
 * a single process that fetches GitHub files directly, embeds them via
 * Bedrock, and upserts into the platform RDS pgvector store.
 *
 * Env vars (see env.ts for required set):
 *   USER_ID, REPO_FULL_NAME, FORCE_REINDEX
 *   GITHUB_TOKEN
 *   PG_HOST, PG_PORT, PG_DATABASE, PG_USER, PG_PASSWORD
 *   AWS_REGION (or AWS_DEFAULT_REGION) — for Bedrock InvokeModel via IRSA
 *
 * Exit codes:
 *   0 — ingestion complete (sync state set to 'complete')
 *   1 — error (sync state set to 'error'); K8s backoffLimit triggers retry
 */

import {
    GitHubAdapter,
    RdsVectorStore,
    RdsSyncStateRepository,
    TitanEmbeddingProvider,
    BedrockChunkEnricher,
    IngestionPipeline,
    FileFilter,
    ChunkerRegistry,
    RepoIngestionOrchestrator,
    bootstrapK8sObservability,
    pushFinalMetrics,
} from '@bedrock/shared';
import { Counter, Histogram } from 'prom-client';

import { parseEnv } from './env.js';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('ingestion-worker');

// Bootstrap observability before any pg / bedrock client constructs so
// auto-instrumentation can hook them. K8s Job — no /metrics server;
// metrics are pushed to Pushgateway in finally{}.
const obs = bootstrapK8sObservability({ serviceName: 'ingestion' });
const log = obs.logger;

const ingestionRuns = new Counter({
    name:       'ingestion_runs_total',
    help:       'Repo ingestion Job runs by terminal outcome.',
    labelNames: ['outcome'] as const,
    registers:  [obs.registry],
});
const ingestionDuration = new Histogram({
    name:       'ingestion_duration_seconds',
    help:       'End-to-end Job duration in seconds.',
    labelNames: ['outcome'] as const,
    buckets:    [5, 15, 30, 60, 120, 300, 600, 1800],
    registers:  [obs.registry],
});
const chunksProcessed = new Counter({
    name:       'ingestion_chunks_total',
    help:       'Chunks processed during ingestion by phase.',
    labelNames: ['phase'] as const,
    registers:  [obs.registry],
});

async function main(): Promise<void> {
    const env = parseEnv();
    const start = process.hrtime.bigint();
    let outcome: 'success' | 'failed' = 'failed';

    log.info({
        userId:       env.userId,
        repoFullName: env.repoFullName,
        forceReindex: env.forceReindex,
    }, 'starting');

    const rdsConfig = {
        host:     env.pg.host,
        port:     env.pg.port,
        database: env.pg.database,
        user:     env.pg.user,
        password: env.pg.password,
    };

    const vectorStore  = new RdsVectorStore(rdsConfig);
    const syncState    = new RdsSyncStateRepository(rdsConfig);
    const embedder     = TitanEmbeddingProvider.fromEnvironment();
    const repoAdapter  = new GitHubAdapter(env.githubToken);
    const fileFilter   = new FileFilter();
    const chunkerReg   = ChunkerRegistry.withDefaults();

    // Skill-evidence enricher. Disable per ingestion via ENRICHMENT_DISABLED=1.
    // Cap per-run cost via MAX_ENRICHMENT_PER_INGESTION (default 2000).
    const enricher = process.env.ENRICHMENT_DISABLED === '1'
        ? undefined
        : BedrockChunkEnricher.fromEnvironment();

    const pipeline     = new IngestionPipeline(vectorStore, syncState, embedder, { enricher });
    const orchestrator = new RepoIngestionOrchestrator(repoAdapter, fileFilter, chunkerReg, pipeline);

    const rootSpan = tracer.startSpan('ingestion.pipeline', {
        attributes: {
            'user.id':        env.userId,
            'repo.full_name': env.repoFullName,
            'force_reindex':  env.forceReindex,
        },
    }, obs.parentContext);

    try {
        const report = await context.with(trace.setSpan(obs.parentContext, rootSpan), async () => {
            return env.forceReindex
                ? await orchestrator.forceReindex(env.userId, env.repoFullName)
                : await orchestrator.ingestRepo(env.userId, env.repoFullName);
        });

        chunksProcessed.inc({ phase: 'embedded' }, report.embedded);
        chunksProcessed.inc({ phase: 'skipped' },  report.skipped);
        chunksProcessed.inc({ phase: 'pruned' },   report.pruned);
        rootSpan.setAttributes({
            'chunks.embedded': report.embedded,
            'chunks.pruned':   report.pruned,
        });
        outcome = 'success';

        const { traceId } = rootSpan.spanContext();
        log.info({
            event:           'ingestion.complete',
            status:          'complete',
            trace_id:         traceId,
            user_id:          env.userId,
            repo_full_name:   env.repoFullName,
            job_name:         process.env['JOB_NAME'] ?? 'unknown',
            embedded:         report.embedded,
            skipped:          report.skipped,
            pruned:           report.pruned,
            duration_ms:      report.durationMs,
            kb_quality_score: report.kbQualityScore,
        }, 'complete');

    } catch (err) {
        rootSpan.recordException(err instanceof Error ? err : new Error(String(err)));
        rootSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        const { traceId } = rootSpan.spanContext();
        log.error({
            event:          'ingestion.complete',
            status:         'error',
            trace_id:        traceId,
            user_id:         env.userId,
            repo_full_name:  env.repoFullName,
        }, 'failed');
        throw err;
    } finally {
        rootSpan.end();
        await Promise.allSettled([vectorStore.end(), syncState.end()]);
        const duration = Number(process.hrtime.bigint() - start) / 1e9;
        ingestionRuns.inc({ outcome });
        ingestionDuration.observe({ outcome }, duration);
        // Group by repoFullName so dashboards show "last run per repo".
        await pushFinalMetrics(obs.registry, 'ingestion', `${env.userId}_${env.repoFullName.replace('/', '_')}`);
        await obs.shutdown();
    }
}

main().catch((err) => {
    log.error({ err }, 'failed');
    process.exit(1);
});
