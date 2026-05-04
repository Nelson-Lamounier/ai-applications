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

    try {
        const report = env.forceReindex
            ? await orchestrator.forceReindex(env.userId, env.repoFullName)
            : await orchestrator.ingestRepo(env.userId, env.repoFullName);

        chunksProcessed.inc({ phase: 'embedded' }, report.embedded);
        chunksProcessed.inc({ phase: 'skipped' },  report.skipped);
        chunksProcessed.inc({ phase: 'pruned' },   report.pruned);
        outcome = 'success';

        log.info({
            userId:         env.userId,
            repoFullName:   env.repoFullName,
            totalRawChunks: report.totalRawChunks,
            embedded:       report.embedded,
            skipped:        report.skipped,
            pruned:         report.pruned,
            inserted:       report.upsertResult.inserted,
            updated:        report.upsertResult.updated,
            errors:         report.upsertResult.errors,
            durationMs:     report.durationMs,
        }, 'complete');
    } finally {
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
