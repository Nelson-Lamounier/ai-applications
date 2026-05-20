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
 *   RETRIEVAL_PROBE_DISABLED — set to "1" to skip the best-effort retrieval-quality probe
 *   RETRIEVAL_PROBE_MODEL_ID — Bedrock model for probe question generation (falls back to PROFILE_EXTRACTOR_MODEL_ID)
 *   MIRROR_REVEAL_MODEL_ID — Bedrock model for profile Mirror/Reveal synthesis (optional; falls back to PROFILE_EXTRACTOR_MODEL_ID; synthesis disabled when neither is set)
 *   DIRECTION_MODEL_ID — Bedrock model for Direction synthesis (optional; falls back to PROFILE_EXTRACTOR_MODEL_ID; direction synthesis disabled when neither is set)
 *   RECONCILIATION_MODEL_ID — Bedrock model for Reconciliation synthesis (optional; falls back to PROFILE_EXTRACTOR_MODEL_ID; reconciliation synthesis disabled when neither is set)
 *   DIAGNOSTIC_MODEL_ID — Bedrock model for Diagnostic narration (optional; falls back to PROFILE_EXTRACTOR_MODEL_ID; the deterministic score is computed regardless; only the LLM paragraph is skipped when neither is set)
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
    RdsUserProfileRollupRepository,
    RdsCareerHistoryReadRepository,
    RdsDiagnosticInputsReadRepository,
} from '@bedrock/shared';
import { Counter, Histogram } from 'prom-client';
import { Pool } from 'pg';

import { parseEnv } from './env.js';
import { ProfileInputCollector } from './agents/ProfileInputCollector.js';
import { ProfileExtractor, sha256 } from './agents/ProfileExtractor.js';
import { RetrievalProbe } from './agents/RetrievalProbe.js';
import { MirrorRevealSynthesizer } from './agents/MirrorRevealSynthesizer.js';
import { DirectionSynthesizer } from './agents/DirectionSynthesizer.js';
import { ReconciliationSynthesizer } from './agents/ReconciliationSynthesizer.js';
import { DiagnosticNarrator } from './agents/DiagnosticNarrator.js';
import { FileFetchCache } from './util/FileFetchCache.js';
import { classifyRepo } from './util/classifyRepo.js';
import { scoreProfile } from './util/scoreProfile.js';
import { refreshUserProfileRollup } from './util/refreshUserProfileRollup.js';
import { RepositoryProfileRepository } from './repositories/RepositoryProfileRepository.js';
import { RepositoryProfileEmbeddingsRepository } from './repositories/RepositoryProfileEmbeddingsRepository.js';
import type { ExtractedRepoData } from './agents/ProfileExtractor.js';
import type { ProfileEmbeddingRow } from './repositories/RepositoryProfileEmbeddingsRepository.js';
import { trace, context, SpanStatusCode } from '@opentelemetry/api';
import {
    profileCollectDurationSeconds,
    profileExtractDurationSeconds,
    profileEmbedDurationSeconds,
    chunkIngestDurationSeconds,
    kbQualityScoreHist,
    profileExtractCallsTotal,
    retrievalScoreHist,
    seedZeroSeries as seedIngestionSubStepSeries,
} from './metrics.js';

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

// Seed sub-stage series so panels show "0" before the first observation.
seedIngestionSubStepSeries();

async function embedProfile(
    userId: string,
    profileId: string,
    extracted: ExtractedRepoData,
    embedder: TitanEmbeddingProvider,
    embRepo: RepositoryProfileEmbeddingsRepository,
): Promise<void> {
    const rows: ProfileEmbeddingRow[] = [];

    const addRow = async (
        chunkType: 'one_liner' | 'description' | 'highlight',
        content: string,
    ): Promise<void> => {
        const embedding   = await embedder.embed(content);
        const contentHash = sha256(content);
        rows.push({ userId, profileId, chunkType, content, contentHash, embedding });
    };

    await addRow('one_liner', extracted.one_liner);
    await addRow('description', extracted.description);
    for (const highlight of extracted.highlights) {
        await addRow('highlight', highlight);
    }

    await embRepo.upsertBatch(userId, rows);
}

/**
 * Mirrors the terminal ingestion outcome back to repositories.index_status so
 * the admin-api's GET /connected-repos fallback (sync_status ?? index_status)
 * stays consistent with repo_sync_state.
 *
 * Best-effort on error path — a failure here must not mask the original error.
 */
async function syncRepositoryIndexStatus(
    pool: Pool,
    userId: string,
    repoFullName: string,
    status: 'complete' | 'error',
    errorMessage?: string,
): Promise<void> {
    await pool.query(
        `UPDATE repositories
         SET index_status  = $3,
             indexed_at    = CASE WHEN $3 = 'complete' THEN NOW() ELSE indexed_at END,
             error_message = $4
         WHERE user_id = $1::uuid AND full_name = $2`,
        [userId, repoFullName, status, errorMessage ?? null],
    );
}

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

    const pgPool = new Pool({
        host:     env.pg.host,
        port:     env.pg.port,
        database: env.pg.database,
        user:     env.pg.user,
        password: env.pg.password,
        max:      3,
    });

    const vectorStore  = new RdsVectorStore(rdsConfig);
    const syncState    = new RdsSyncStateRepository(rdsConfig);
    const embedder     = new TitanEmbeddingProvider(
        process.env.AWS_REGION ?? 'eu-west-1',
        (process.env.EMBEDDING_DIMENSION
            ? (parseInt(process.env.EMBEDDING_DIMENSION, 10) as 256 | 512 | 1024)
            : 1024),
        { pool: pgPool, userId: env.userId, repoName: env.repoFullName },
    );
    const repoAdapter  = new GitHubAdapter(env.githubToken);
    const fileFilter   = new FileFilter();
    const chunkerReg   = ChunkerRegistry.withDefaults();

    // Skill-evidence enricher. Disable per ingestion via ENRICHMENT_DISABLED=1.
    // Cap per-run cost via MAX_ENRICHMENT_PER_INGESTION (default 2000).
    const enricher = process.env.ENRICHMENT_DISABLED === '1'
        ? undefined
        : BedrockChunkEnricher.fromEnvironment();

    const retrievalProbe = RetrievalProbe.fromEnvironment(pgPool, env.userId, env.repoFullName);

    const pipeline     = new IngestionPipeline(vectorStore, syncState, embedder, { enricher, retrievalProbe });
    const orchestrator = new RepoIngestionOrchestrator(repoAdapter, fileFilter, chunkerReg, pipeline);

    const fileCache        = new FileFetchCache();
    const profileRepo      = new RepositoryProfileRepository(pgPool);
    const rollupRepo       = new RdsUserProfileRollupRepository(pgPool);
    const embRepo          = new RepositoryProfileEmbeddingsRepository(pgPool);
    const profileExtractor = new ProfileExtractor(env.profileExtractorModelId, pgPool);
    const profileCollector = new ProfileInputCollector(repoAdapter, fileCache);

    const rootSpan = tracer.startSpan('ingestion.pipeline', {
        attributes: {
            'user.id':        env.userId,
            'repo.full_name': env.repoFullName,
            'force_reindex':  env.forceReindex,
        },
    }, obs.parentContext);

    try {
        // ── Phase 0: profile extraction ──────────────────────────────────────────
        log.info({ repoFullName: env.repoFullName }, 'profile_extraction.start');

        const stopCollect    = profileCollectDurationSeconds().startTimer();
        const bundle         = await profileCollector.collect(env.repoFullName);
        stopCollect();
        const classification = classifyRepo(bundle);

        const { id: profileId } = await profileRepo.upsert({
            userId:           env.userId,
            repoFullName:     env.repoFullName,
            extractionStatus: 'extracting',
            extractorModel:   env.profileExtractorModelId,
            extractorVersion: profileExtractor.version,
        });

        try {
            const stopExtract = profileExtractDurationSeconds().startTimer();
            const extracted   = await profileExtractor.extract(env.userId, bundle);
            stopExtract();
            const { score, breakdown } = scoreProfile(extracted, bundle);
            kbQualityScoreHist().observe(score);

            await profileRepo.upsert({
                userId:           env.userId,
                repoFullName:     env.repoFullName,
                extracted,
                classification,
                qualityScore:     score,
                qualityBreakdown: breakdown,
                extractionStatus: 'ready_for_review',
                extractedAt:      new Date(),
                extractorModel:   env.profileExtractorModelId,
                extractorVersion: profileExtractor.version,
            });

            const stopEmbed = profileEmbedDurationSeconds().startTimer();
            await embedProfile(env.userId, profileId, extracted, embedder, embRepo);
            stopEmbed();
            await profileRepo.updateStatus(profileId, env.userId, 'completed');
            profileExtractCallsTotal().inc({ outcome: 'success' });
            const mirrorSynth = MirrorRevealSynthesizer.fromEnvironment(pgPool, env.userId);
            const directionSynth = DirectionSynthesizer.fromEnvironment(pgPool, env.userId);
            const careerRepo = new RdsCareerHistoryReadRepository(pgPool);
            const reconciliationSynth = ReconciliationSynthesizer.fromEnvironment(pgPool, env.userId);
            const diagnosticInputsRepo = new RdsDiagnosticInputsReadRepository(pgPool);
            const diagnosticNarrator   = DiagnosticNarrator.fromEnvironment(pgPool, env.userId);
            await refreshUserProfileRollup(rollupRepo, env.userId, mirrorSynth, directionSynth, reconciliationSynth, careerRepo, diagnosticNarrator, diagnosticInputsRepo);

            log.info({
                repoFullName:  env.repoFullName,
                classification,
                qualityScore:  score,
                domain:        extracted.domain,
                confidence:    extracted.confidence,
            }, 'profile_extraction.complete');
        } catch (profileErr) {
            profileExtractCallsTotal().inc({ outcome: 'failed' });
            await profileRepo.updateStatus(profileId, env.userId, 'failed', String(profileErr));
            throw profileErr;
        }

        const stopChunkIngest = chunkIngestDurationSeconds().startTimer();
        const report = await context.with(trace.setSpan(obs.parentContext, rootSpan), async () => {
            return env.forceReindex
                ? await orchestrator.forceReindex(env.userId, env.repoFullName)
                : await orchestrator.ingestRepo(env.userId, env.repoFullName);
        });
        stopChunkIngest({ outcome: 'success' });

        chunksProcessed.inc({ phase: 'embedded' }, report.embedded);
        chunksProcessed.inc({ phase: 'skipped' },  report.skipped);
        chunksProcessed.inc({ phase: 'pruned' },   report.pruned);
        if (typeof report.retrievalScore === 'number') {
            retrievalScoreHist().observe(report.retrievalScore);
        }
        rootSpan.setAttributes({
            'chunks.embedded': report.embedded,
            'chunks.pruned':   report.pruned,
        });

        await syncRepositoryIndexStatus(pgPool, env.userId, env.repoFullName, 'complete');
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
            retrieval_score:  report.retrievalScore,
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
        const errMsg = err instanceof Error ? err.message : String(err);
        await syncRepositoryIndexStatus(
            pgPool, env.userId, env.repoFullName, 'error', errMsg.slice(0, 500),
        ).catch(() => {}); // best-effort — must not mask the original error
        throw err;
    } finally {
        rootSpan.end();
        await Promise.allSettled([vectorStore.end(), syncState.end(), pgPool.end()]);
        const duration = Number(process.hrtime.bigint() - start) / 1e9;
        ingestionRuns.inc({ outcome });
        ingestionDuration.observe({ outcome }, duration);
        // Group by repoFullName so dashboards show "last run per repo".
        await pushFinalMetrics(obs.registry, 'ingestion', `${env.userId}_${env.repoFullName.replace('/', '_')}`);
        // sdk.shutdown() flushes OTel spans to Alloy; cap at 10s to prevent
        // a hung HTTP connection from blocking pod exit until the job deadline.
        await Promise.race([obs.shutdown(), new Promise(r => setTimeout(r, 10_000))]);
    }
}

main().catch((err) => {
    log.error({ err }, 'failed');
    process.exit(1);
});
