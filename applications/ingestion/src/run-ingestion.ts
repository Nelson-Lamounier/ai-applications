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
    IngestionPipeline,
    FileFilter,
    ChunkerRegistry,
    RepoIngestionOrchestrator,
} from '@bedrock/shared';

import { parseEnv } from './env.js';

async function main(): Promise<void> {
    const env = parseEnv();

    console.info('[run-ingestion] starting', {
        userId:       env.userId,
        repoFullName: env.repoFullName,
        forceReindex: env.forceReindex,
    });

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
    const pipeline     = new IngestionPipeline(vectorStore, syncState, embedder);
    const orchestrator = new RepoIngestionOrchestrator(repoAdapter, fileFilter, chunkerReg, pipeline);

    try {
        const report = env.forceReindex
            ? await orchestrator.forceReindex(env.userId, env.repoFullName)
            : await orchestrator.ingestRepo(env.userId, env.repoFullName);

        console.info('[run-ingestion] complete', {
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
        });
    } finally {
        await Promise.allSettled([vectorStore.end(), syncState.end()]);
    }
}

main().catch((err) => {
    console.error('[run-ingestion] failed', err);
    process.exit(1);
});
