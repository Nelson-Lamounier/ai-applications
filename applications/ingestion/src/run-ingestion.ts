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
    SkillOntologyRepository,
    SkillEmbeddingResolver,
    PhraseSkillResolver,
    backfillSkillEmbeddings,
    IngestionPipeline,
    FileFilter,
    ChunkerRegistry,
    RepoIngestionOrchestrator,
    bootstrapK8sObservability,
    pushFinalMetrics,
    RdsUserProfileRollupRepository,
    RdsCareerHistoryReadRepository,
    RdsDiagnosticInputsReadRepository,
    RdsRepoActivityStore,
    RdsRepoFileStateRepository,
    stampUserEvidenceMetadata,
    TechSkillMapRepository,
    reconcileRepoName,
} from '@bedrock/shared';
import { Counter, Histogram } from 'prom-client';
import { Pool } from 'pg';

import { createHash } from 'node:crypto';
import { parseEnv } from './env.js';
import { ProfileInputCollector } from './agents/ProfileInputCollector.js';
import type { ProfileInputBundle } from './agents/ProfileInputCollector.js';
import type { RepoClassification } from './util/classifyRepo.js';
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
import { reenrichSkippedChunks } from './util/reenrichSkippedChunks.js';
import { patchDeterministicProfileFacts } from './util/patchProfileFacts.js';
import { friendlyIngestionError } from './friendly-error.js';
import type { RepoFile } from '@bedrock/shared';
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
    help:       'Repo ingestion Job runs by terminal outcome and sync type.',
    labelNames: ['outcome', 'sync_type'] as const,   // sync_type: initial | full_reindex | incremental
    registers:  [obs.registry],
});
const ingestionDuration = new Histogram({
    name:       'ingestion_duration_seconds',
    help:       'End-to-end Job duration in seconds by outcome and sync type.',
    labelNames: ['outcome', 'sync_type'] as const,
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

/**
 * Sum booked Bedrock spend (USD) from `prompt_invocations` for this repo since a
 * cut-off, optionally scoped to one agent lane. Every cost lane (embeddings,
 * enrichment, probe, profile agents) books here, so this is the authoritative
 * source for run cost — no per-call plumbing required. Best-effort: any failure
 * returns zeros so cost reporting never affects the ingestion outcome.
 */
async function sumBookedCostUsd(
    pgPool: Pool,
    userId: string,
    repoFullName: string,
    sinceIso: string,
    agent?: string,
): Promise<{ costUsd: number; invocations: number }> {
    try {
        const { rows } = await pgPool.query<{ cents: string; n: string }>(
            `SELECT COALESCE(SUM(total_cost_cents), 0) AS cents, COUNT(*) AS n
               FROM prompt_invocations
              WHERE user_id = $1::uuid AND repo_name = $2 AND invoked_at >= $3
                ${agent ? 'AND agent = $4' : ''}`,
            agent ? [userId, repoFullName, sinceIso, agent] : [userId, repoFullName, sinceIso],
        );
        const cents = Number(rows[0]?.cents ?? 0);
        return { costUsd: Number((cents / 100).toFixed(6)), invocations: Number(rows[0]?.n ?? 0) };
    } catch (err) {
        log.warn({ err: String(err), repoFullName }, 'cost_sum.failed (non-fatal)');
        return { costUsd: 0, invocations: 0 };
    }
}

/**
 * Per-agent cost + invocation breakdown for this repo since a cut-off. Names
 * exactly which component handled each lane (titan-embed builds
 * document_embeddings; chunk-enrich adds skills; profile-* synthesize the
 * profile). Best-effort: returns [] on any failure.
 */
async function costBreakdownByAgent(
    pgPool: Pool,
    userId: string,
    repoFullName: string,
    sinceIso: string,
): Promise<Array<{ agent: string; model: string; invocations: number; costUsd: number }>> {
    try {
        const { rows } = await pgPool.query<{ agent: string; model_id: string; n: string; cents: string }>(
            `SELECT agent, model_id,
                    COUNT(*) AS n,
                    COALESCE(SUM(total_cost_cents), 0) AS cents
               FROM prompt_invocations
              WHERE user_id = $1::uuid AND repo_name = $2 AND invoked_at >= $3
              GROUP BY agent, model_id
              ORDER BY cents DESC`,
            [userId, repoFullName, sinceIso],
        );
        return rows.map(r => ({
            agent:       r.agent,
            model:       r.model_id,
            invocations: Number(r.n),
            costUsd:     Number((Number(r.cents) / 100).toFixed(6)),
        }));
    } catch (err) {
        log.warn({ err: String(err), repoFullName }, 'cost_breakdown.failed (non-fatal)');
        return [];
    }
}

/**
 * Background skill enrichment for DEFER_ENRICHMENT runs — enrich the 'pending'
 * chunks in place after the repo is already searchable. No re-embedding;
 * best-effort, never throws (a failure must not flip the ingestion outcome).
 */
/**
 * Wall (epoch-ms) by which deferred enrichment must stop dispatching, derived
 * from the pod's `activeDeadlineSeconds` minus a margin that reserves time for
 * the profile-synthesis phase + graceful exit that run AFTER enrichment. On a
 * large repo, enrichment would otherwise run into the deadline and get the pod
 * SIGKILLed — marking an already-complete KB as a Failed (DeadlineExceeded)
 * Job. Stopping early instead leaves the remainder `pending` (resumed next
 * ordinary sync) and lets the run exit 0. Returns undefined (no bound) when the
 * deadline env is unset/non-positive.
 */
function enrichmentDeadlineMs(): number | undefined {
    const deadlineSec = Number(process.env['INGESTION_DEADLINE_SECONDS'] ?? 900);
    const marginSec   = Number(process.env['ENRICHMENT_BUDGET_MARGIN_SECONDS'] ?? 180);
    if (!Number.isFinite(deadlineSec) || deadlineSec <= 0) return undefined;
    const budgetSec = deadlineSec - (Number.isFinite(marginSec) ? marginSec : 180);
    if (budgetSec <= 0) return undefined;
    const processStartMs = Date.now() - process.uptime() * 1000;
    return processStartMs + budgetSec * 1000;
}

async function runDeferredEnrichment(
    pgPool: Pool,
    enricher: BedrockChunkEnricher,
    userId: string,
    repoFullName: string,
): Promise<void> {
    // Cut-off so the cost sum below counts only THIS pass's enrichment calls.
    const startedAt = new Date().toISOString();
    // Tier 1 (spec 003): load the tech->skill map so chunks with file_tech_stack
    // (stamped just above, before this pass) resolve deterministically — no LLM.
    const tier1Map = process.env['ENRICH_TIER1'] === '1'
        ? await new TechSkillMapRepository(pgPool).loadTechSkillMap().catch(() => undefined)
        : undefined;
    // Controlled-vocab enrichment (the vocabulary fix): emit ONLY canonical
    // skill_ontology terms so the chunk is canonical and the && lane fires.
    const canonicalVocab = process.env['ENRICH_CANONICAL'] === '1'
        ? await new SkillOntologyRepository(pgPool).loadCanonicalNames().catch(() => undefined)
        : undefined;
    try {
        const reenriched = await reenrichSkippedChunks(pgPool, enricher, {
            userId,
            repoFullName,
            tier1Map,
            canonicalVocab,
            // WS5 content-hash dedup: copy skills for byte-identical chunks instead
            // of re-invoking the LLM. On by default; ENRICH_DEDUP=0 disables.
            dedupCache: process.env['ENRICH_DEDUP'] !== '0',
            deadlineMs: enrichmentDeadlineMs(),
            onProgress: (done, total) => {
                if (done % 100 === 0 || done === total) {
                    log.info({ done, total, repoFullName }, 'deferred_enrichment.progress');
                }
            },
        });
        // The enrichment lane (agent='chunk-enrich') was previously invisible in
        // the logs despite being the bulk of a run's spend. Surface it here.
        const cost = await sumBookedCostUsd(pgPool, userId, repoFullName, startedAt, 'chunk-enrich');
        log.info(
            { event: 'deferred_enrichment.complete', repoFullName, ...reenriched, cost_usd: cost.costUsd },
            'deferred enrichment complete',
        );
        // A deliberate early stop is normal for big repos — make it explicit so a
        // partial enrichment isn't mistaken for a failure. The `remaining` rows
        // stay `pending` and the next ordinary sync resumes them.
        if (reenriched.stoppedEarly) {
            log.warn(
                { event: 'deferred_enrichment.stopped_early', repoFullName, remaining: reenriched.remaining },
                'deferred enrichment hit its time budget — remaining chunks left pending for the next sync',
            );
        }
    } catch (err) {
        log.warn({ err: String(err), repoFullName }, 'deferred_enrichment.failed (non-fatal)');
    }
}

/**
 * Self-heal the skill-ontology embeddings (migration 094), then build the
 * phrase -> canonical resolver callback the enricher uses as its fuzzy fallback.
 *
 * The backfill is idempotent (only NULL-embedding rows are fetched) so it is a
 * no-op after the first run that fills the ~75-row seed. Returns undefined when
 * the ontology has no embedded skills — the resolver could never match, so the
 * enricher cleanly stays alias-only rather than paying a wasted embed per phrase.
 */
async function buildSkillResolver(
    pool: Pool,
    skillOntologyRepo: SkillOntologyRepository,
    embedder: TitanEmbeddingProvider,
): Promise<((phrase: string) => Promise<string | null>) | undefined> {
    const embedded = await backfillSkillEmbeddings(skillOntologyRepo, embedder);
    if (embedded > 0) console.info(`[ingestion] skill ontology: embedded ${embedded} new canonical(s)`);

    const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM skill_ontology WHERE embedding IS NOT NULL`,
    );
    if (Number(rows[0]?.n ?? 0) === 0) return undefined;

    const threshold = process.env.SKILL_MATCH_THRESHOLD
        ? Number.parseFloat(process.env.SKILL_MATCH_THRESHOLD)
        : undefined;
    const resolver = new SkillEmbeddingResolver(pool, threshold);
    const phraseResolver = new PhraseSkillResolver(embedder, resolver);
    return (phrase: string) => phraseResolver.resolve(phrase);
}

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
 * Decide whether profile extraction can be skipped (WS4 Gate 1). The extract LLM
 * is a pure function of the repo HEAD + extractor version/model; if that hash is
 * unchanged since a completed extraction (and not a forced reindex), skip it.
 * Returns the hash so the caller can stamp it when it does extract.
 */
async function evaluateExtractSkip(
    profileRepo: RepositoryProfileRepository,
    env: { userId: string; repoFullName: string; profileExtractorModelId?: string; forceReindex: boolean },
    commitSha: string | null,
    extractorVersion: string,
): Promise<{ skip: boolean; inputHash: string }> {
    const inputHash = createHash('sha256')
        .update(`${commitSha ?? ''}|${extractorVersion}|${env.profileExtractorModelId ?? ''}`)
        .digest('hex');
    const prior = await profileRepo.getInputState(env.userId, env.repoFullName).catch(() => null);
    const skip = !env.forceReindex && !!commitSha
        && prior?.inputHash === inputHash && prior.extractionStatus === 'completed';
    return { skip, inputHash };
}

/**
 * Run profile extraction + embedding for one repo (the LLM-calling core of Phase
 * 0). Stamps `profileInputHash` on the persisted profile so the next unchanged
 * sync can skip this entirely. Extracted from main so the Phase-0 skip gate keeps
 * run-ingestion's complexity flat.
 */
async function doExtractAndEmbed(
    deps: {
        profileRepo: RepositoryProfileRepository;
        profileExtractor: ProfileExtractor;
        embedder: TitanEmbeddingProvider;
        embRepo: RepositoryProfileEmbeddingsRepository;
    },
    env: { userId: string; repoFullName: string; profileExtractorModelId?: string },
    bundle: ProfileInputBundle,
    classification: RepoClassification,
    inputHash: string,
): Promise<void> {
    const { id: profileId } = await deps.profileRepo.upsert({
        userId:           env.userId,
        repoFullName:     env.repoFullName,
        extractionStatus: 'extracting',
        extractorModel:   env.profileExtractorModelId,
        extractorVersion: deps.profileExtractor.version,
    });
    try {
        const stopExtract = profileExtractDurationSeconds().startTimer();
        const extracted   = await deps.profileExtractor.extract(env.userId, bundle);
        stopExtract();
        const { score, breakdown } = scoreProfile(extracted, bundle);
        kbQualityScoreHist().observe(score);

        await deps.profileRepo.upsert({
            userId:           env.userId,
            repoFullName:     env.repoFullName,
            extracted,
            classification,
            qualityScore:     score,
            qualityBreakdown: breakdown,
            extractionStatus: 'ready_for_review',
            extractedAt:      new Date(),
            extractorModel:   env.profileExtractorModelId,
            extractorVersion: deps.profileExtractor.version,
            profileInputHash: inputHash,
        });

        const stopEmbed = profileEmbedDurationSeconds().startTimer();
        await embedProfile(env.userId, profileId, extracted, deps.embedder, deps.embRepo);
        stopEmbed();
        await deps.profileRepo.updateStatus(profileId, env.userId, 'completed');
        profileExtractCallsTotal().inc({ outcome: 'success' });

        log.info({
            repoFullName: env.repoFullName, classification,
            qualityScore: score, domain: extracted.domain, confidence: extracted.confidence,
        }, 'profile_extraction.complete');
    } catch (profileErr) {
        profileExtractCallsTotal().inc({ outcome: 'failed' });
        await deps.profileRepo.updateStatus(profileId, env.userId, 'failed', String(profileErr));
        throw profileErr;
    }
}

/**
 * Resolves the repositories.id for the (user, repo) pair so structured
 * commit/PR rows can be FK-linked. Returns null when no row exists (e.g. the
 * repo was never registered via the connect flow) — the caller then skips
 * structured persistence rather than failing the whole ingestion.
 */
async function resolveRepositoryId(pool: Pool, userId: string, repoFullName: string): Promise<string | null> {
    const r = await pool.query<{ id: string }>(
        `SELECT id FROM repositories WHERE user_id = $1::uuid AND full_name = $2`,
        [userId, repoFullName],
    );
    return r.rows[0]?.id ?? null;
}

/**
 * Best-effort deterministic profile-facts patch (workstream 1). Overwrites the
 * profile's commit_count + role_inferred from the freshly-written repo_commits.
 * Never fatal — a failure leaves the LLM's values until the next run.
 */
async function applyDeterministicProfileFacts(
    pool: Pool, userId: string, repoFullName: string, repositoryId: string | null,
): Promise<void> {
    try {
        const facts = await patchDeterministicProfileFacts(pool, { userId, repoFullName, repositoryId });
        log.info({ event: 'profile_facts.patched', repoFullName, ...facts }, 'deterministic profile facts patched');
    } catch (err) {
        log.warn({ event: 'profile_facts.skipped', repoFullName, err }, 'deterministic profile-facts patch skipped (non-fatal)');
    }
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

/**
 * Run a teardown promise but never block longer than `ms`. Cleanup (pool drain,
 * telemetry flush) must not hold a one-shot Job past its K8s deadline — the
 * work + status are already persisted by the time we get here.
 */
async function withTimeout(p: Promise<unknown>, ms: number, label: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
            log.warn({ label, ms }, 'teardown step timed out — continuing to exit');
            resolve();
        }, ms);
    });
    try {
        await Promise.race([p.then(() => undefined).catch(() => undefined), timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Self-heal a stale stored repo name before the run touches GitHub. When the
 * dispatcher supplied the immutable `github_repo_id`, resolve the repo's CURRENT
 * full_name by id (rename-proof — `GET /repositories/{id}` always returns the
 * live name) and, if it differs from the stored name, re-stamp the denormalised
 * label everywhere via reconcileRepoName. Returns the name the rest of the run
 * should use (the current one on a rename, otherwise the unchanged input).
 *
 * Legacy/pre-backfill runs (no id on the job spec) skip self-heal entirely and
 * keep the supplied name. A RepoNotFoundError (deleted/revoked) is routed to the
 * same error sink as any other failure — markError + friendly message + raw
 * detail on repositories — then rethrown so the run terminates as a clean sync
 * error rather than crashing.
 */
async function selfHealRepoName(deps: {
    pool:    Pool;
    adapter: GitHubAdapter;
    syncState: RdsSyncStateRepository;
    userId:  string;
    githubRepoId: number | null;
    storedFullName: string;
}): Promise<string> {
    const { pool, adapter, syncState, userId, githubRepoId, storedFullName } = deps;
    if (githubRepoId === null) return storedFullName;

    try {
        const ref = await adapter.resolveById(githubRepoId);
        if (ref.fullName === storedFullName) return storedFullName;

        await reconcileRepoName(pool, userId, githubRepoId, ref.fullName);
        log.info(
            { event: 'repo_rename.self_healed', githubRepoId, from: storedFullName, to: ref.fullName, userId },
            'repo renamed since last sync — re-stamped label and continuing under the current name',
        );
        return ref.fullName;
    } catch (err) {
        const friendly = friendlyIngestionError(err);
        const errMsg = err instanceof Error ? err.message : String(err);
        await syncState.markError(userId, storedFullName, friendly).catch(() => {});
        await syncRepositoryIndexStatus(
            pool, userId, storedFullName, 'error', errMsg.slice(0, 500),
        ).catch(() => {});
        throw err;
    }
}

async function main(): Promise<void> {
    let env = parseEnv();
    const start = process.hrtime.bigint();
    // Wall-clock cut-off for the end-of-run cost roll-up (prompt_invocations.invoked_at).
    const runStartIso = new Date().toISOString();
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

    // Classify the run for sync/resync metrics: 'initial' (repo never embedded),
    // 'full_reindex' (forced re-embed of everything), or 'incremental' (push-based
    // delta of changed files). Determined from prior embeddings + FORCE_REINDEX.
    let syncType: 'initial' | 'full_reindex' | 'incremental' =
        env.forceReindex ? 'full_reindex' : 'incremental';
    try {
        const prior = await pgPool.query<{ c: number }>(
            'SELECT COUNT(*)::int AS c FROM document_embeddings WHERE user_id = $1::uuid AND repo_full_name = $2',
            [env.userId, env.repoFullName],
        );
        if ((prior.rows[0]?.c ?? 0) === 0) syncType = 'initial';
    } catch { /* keep the FORCE_REINDEX-derived default if the probe fails */ }

    // Dual-write the immutable github_repo_id onto every repo-scoped upsert (null
    // pre-backfill — the column is nullable and a later id-bearing run / the
    // backfill fills it). The id is constant for the whole run, so it is injected
    // once at construction rather than threaded through each writer call.
    const githubRepoId = env.githubRepoId;
    const repoAdapter  = new GitHubAdapter(env.githubToken);
    // Head commit of the synced content — stamped onto every chunk's
    // metadata.commit_sha for source provenance (file:line@commit when paired
    // with the chunk line ranges). Fail-safe: a resolve error leaves it null
    // and chunks persist without the stamp — never blocks ingestion.
    const commitSha = await repoAdapter.getHeadCommitSha(env.repoFullName).catch(() => null);
    const syncState    = new RdsSyncStateRepository(rdsConfig, githubRepoId);

    // Rename self-heal — BEFORE any object captures repoFullName and before the
    // first GitHub fetch. If the dispatcher supplied GITHUB_REPO_ID and the repo
    // was renamed since the last sync, resolve the current name by id, re-stamp
    // the denormalised label everywhere, and continue under the current name by
    // reassigning `env`. RepoNotFoundError is sunk + rethrown inside the helper.
    const healedName = await selfHealRepoName({
        pool:    pgPool,
        adapter: repoAdapter,
        syncState,
        userId:  env.userId,
        githubRepoId:   env.githubRepoId,
        storedFullName: env.repoFullName,
    });
    if (healedName !== env.repoFullName) {
        env = { ...env, repoFullName: healedName };
    }

    const embedder     = new TitanEmbeddingProvider(
        process.env.AWS_REGION ?? 'eu-west-1',
        (process.env.EMBEDDING_DIMENSION
            ? (parseInt(process.env.EMBEDDING_DIMENSION, 10) as 256 | 512 | 1024)
            : 1024),
        { pool: pgPool, userId: env.userId, repoName: env.repoFullName, syncKind: syncType },
    );
    const fileFilter   = new FileFilter();
    const chunkerReg   = ChunkerRegistry.withDefaults();

    // Skill-evidence enricher. Disable entirely via ENRICHMENT_DISABLED=1, or
    // DEFER_ENRICHMENT=1 to take it off the critical path: the pipeline skips
    // inline enrichment (tags chunks 'pending') and a background pass below
    // backfills skills after the repo is marked searchable. Cap per-run inline
    // cost via MAX_ENRICHMENT_PER_INGESTION (default 4000).
    const deferEnrichment = process.env.DEFER_ENRICHMENT === '1';
    let enricher: BedrockChunkEnricher | undefined;
    if (process.env.ENRICHMENT_DISABLED !== '1') {
        // Canonicalise emitted skills against the skill ontology (migration 092)
        // so LLM variance collapses deterministically. Fail-safe: a load error
        // leaves the map undefined and skills pass through as raw — never blocks
        // ingestion.
        const skillOntologyRepo = new SkillOntologyRepository(pgPool);
        const skillAliasToCanonical = await skillOntologyRepo
            .loadAliasToCanonicalMap()
            .catch(() => undefined);

        // Self-heal the ontology embeddings (migration 094) before enrichment so
        // the fuzzy resolver has vectors to match against. Idempotent: only rows
        // with a NULL embedding are fetched, so this is a no-op after the first
        // run. Fail-safe: any error leaves resolveSkill unbuilt and the enricher
        // falls back to alias-only — never blocks ingestion.
        const resolveSkill = await buildSkillResolver(pgPool, skillOntologyRepo, embedder)
            .catch((err) => { console.warn('[ingestion] skill embedding resolver disabled (non-fatal)', err); return undefined; });

        enricher = BedrockChunkEnricher.fromEnvironment(
            {
                pool:     pgPool,
                userId:   env.userId,
                repoName: env.repoFullName,
                syncKind: syncType,
            },
            skillAliasToCanonical,
            resolveSkill,
        );
    }

    const retrievalProbe = RetrievalProbe.fromEnvironment(pgPool, env.userId, env.repoFullName);

    // Embedding/enrichment lineage stamped onto every chunk (metadata.lineage)
    // so a chunk can be reproduced / audited / invalidated when a model or
    // dimension changes. Built from the live providers (single source of truth).
    const lineage: Record<string, unknown> = {
        embedding_model: embedder.modelId,
        embedding_dim:   embedder.dimension,
        ...(enricher ? { enrichment_model: enricher.modelId } : {}),
    };
    const vectorStore = new RdsVectorStore(rdsConfig, undefined, githubRepoId, commitSha, lineage);

    // In defer mode the pipeline gets no inline enricher; `enricher` above is
    // reused by the post-completion re-enrich pass.
    const pipeline = new IngestionPipeline(vectorStore, syncState, embedder, {
        enricher: deferEnrichment ? undefined : enricher,
        retrievalProbe,
        deferEnrichment,
    });

    const repositoryId  = await resolveRepositoryId(pgPool, env.userId, env.repoFullName);
    if (!repositoryId) {
        console.warn(`[run-ingestion] no repositories row for ${env.repoFullName}; structured commit/PR persistence will be skipped`);
    }
    const activityStore  = new RdsRepoActivityStore(pgPool, githubRepoId);
    const fileStateStore = new RdsRepoFileStateRepository(pgPool, githubRepoId);

    const orchestrator = new RepoIngestionOrchestrator(
        repoAdapter, fileFilter, chunkerReg, pipeline,
        {
            activityStore,
            repositoryId: repositoryId ?? undefined,
            syncStateSignalSink: syncState,
            fileStateStore,
            watermarkStore: syncState,
        },
    );

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
        // Flip pending → syncing and reset stale phase/progress immediately so
        // the UI leaves 0%/"pending" the moment the pod starts, then mark the
        // first (indeterminate) phase.
        await syncState.beginRun(env.userId, env.repoFullName).catch(() => {});
        await syncState.markPhase(env.userId, env.repoFullName, 'analyzing').catch(() => {});

        // ── Phase 0: profile extraction ──────────────────────────────────────────
        log.info({ repoFullName: env.repoFullName }, 'profile_extraction.start');

        // Fetch the repo file tree ONCE and share it with profile collection +
        // the orchestrator (avoids a duplicate GitHub tree API call per run).
        // Best-effort: on failure each consumer fetches its own tree.
        let prefetchedFiles: RepoFile[] | undefined;
        try {
            prefetchedFiles = await repoAdapter.listFiles(env.repoFullName);
        } catch {
            prefetchedFiles = undefined;
        }

        // Skip-unchanged gate (WS4): no LLM when the repo HEAD + extractor are
        // unchanged since a completed extraction. Any new commit changes HEAD.
        const { skip: skipExtract, inputHash: profileInputHash } =
            await evaluateExtractSkip(profileRepo, env, commitSha, profileExtractor.version);

        if (skipExtract) {
            log.info({ repoFullName: env.repoFullName, commitSha }, 'profile_extraction.skipped_unchanged');
        } else {
            const stopCollect    = profileCollectDurationSeconds().startTimer();
            const bundle         = await profileCollector.collect(env.repoFullName, prefetchedFiles);
            stopCollect();
            const classification = classifyRepo(bundle);
            await doExtractAndEmbed({ profileRepo, profileExtractor, embedder, embRepo }, env, bundle, classification, profileInputHash);
        }

        // Surface file-fetch progress to the UI (the 'fetching' phase). Fire-
        // and-forget; a progress write must never affect ingestion.
        const onFileProgress = (fetched: number, total: number) => {
            void syncState.markPhase(env.userId, env.repoFullName, 'fetching', fetched, total).catch(() => {});
        };

        const stopChunkIngest = chunkIngestDurationSeconds().startTimer();
        const report = await context.with(trace.setSpan(obs.parentContext, rootSpan), async () => {
            return env.forceReindex
                ? await orchestrator.forceReindex(env.userId, env.repoFullName, prefetchedFiles)
                : await orchestrator.ingestRepo(env.userId, env.repoFullName, onFileProgress, prefetchedFiles);
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

        // Deterministic profile facts: now that the orchestrator has written
        // repo_commits, overwrite the profile's commit_count (was a 30-capped
        // sentinel) + role_inferred (was LLM-guessed) from the real history.
        await applyDeterministicProfileFacts(pgPool, env.userId, env.repoFullName, repositoryId);

        // Stamp evidence metadata (verified-authorship + tech) onto this repo's chunks
        // so filter-then-rank retrieval can gate fork/low-trust evidence + pre-filter by
        // tech. Reads already-persisted profile/commits/tech; best-effort, never fatal.
        try {
            const stamped = await stampUserEvidenceMetadata(pgPool, env.userId, env.repoFullName);
            console.info(`[run-ingestion] evidence-metadata stamped: ${stamped} repo(s)`);
        } catch (err) {
            console.warn(`[run-ingestion] evidence-metadata stamp skipped for ${env.repoFullName}:`, err);
        }

        // Record the sync classification on the (already-upserted) repo_sync_state
        // row so the dashboard can show which repos were initial vs full-reindex vs
        // incremental, and when. Best-effort.
        await pgPool.query(
            'UPDATE repo_sync_state SET last_sync_type = $3 WHERE user_id = $1::uuid AND repo_full_name = $2',
            [env.userId, env.repoFullName, syncType],
        ).catch(() => { /* non-fatal — metric still carries sync_type */ });

        // Append this probe run to history (repo_sync_state only keeps the latest,
        // overwriting each sync). Copies the just-written breakdown so retrieval
        // quality is longitudinal — enables same-repo comparison across syncs
        // without re-running an eval. retrieval_mode reflects the probe strategy
        // ('hybrid' since the probe queries vector+BM25 RRF). Best-effort.
        await pgPool.query(
            `INSERT INTO retrieval_probe_history
               (user_id, repo_full_name, sync_type, retrieval_mode, sampled,
                recall_at_3, mrr, mean_top_similarity, score, breakdown)
             SELECT $1::uuid, $2, $3, 'hybrid',
                    (retrieval_breakdown->>'sampled')::int,
                    (retrieval_breakdown->>'recallAt3')::numeric,
                    (retrieval_breakdown->>'mrr')::numeric,
                    (retrieval_breakdown->>'meanTopSimilarity')::numeric,
                    retrieval_score,
                    retrieval_breakdown
               FROM repo_sync_state
              WHERE user_id = $1::uuid AND repo_full_name = $2
                AND retrieval_breakdown IS NOT NULL
                AND retrieval_breakdown->>'status' = 'ok'`,
            [env.userId, env.repoFullName, syncType],
        ).catch(() => { /* non-fatal — history is best-effort analytics */ });

        // The repo is already searchable above. In defer mode, fill `skills` off
        // the critical path now (in-process, no re-embedding). Best-effort.
        if (deferEnrichment && enricher) {
            await runDeferredEnrichment(pgPool, enricher, env.userId, env.repoFullName);
        }

        // ── Profile rollup + synthesis (runs AFTER completion) ───────────────────
        // Must run here, not during profile extraction: the diagnostic's ragDepth
        // reads kb_quality_score + retrieval_score from repo_sync_state, which are
        // only written by markComplete above. Running it earlier scored ragDepth=0
        // against pre-ingestion state. Best-effort — never throws, never flips the
        // already-'complete' repo.
        {
            const mirrorSynth          = MirrorRevealSynthesizer.fromEnvironment(pgPool, env.userId);
            const directionSynth       = DirectionSynthesizer.fromEnvironment(pgPool, env.userId);
            const careerRepo           = new RdsCareerHistoryReadRepository(pgPool);
            const reconciliationSynth  = ReconciliationSynthesizer.fromEnvironment(pgPool, env.userId);
            const diagnosticInputsRepo = new RdsDiagnosticInputsReadRepository(pgPool);
            const diagnosticNarrator   = DiagnosticNarrator.fromEnvironment(pgPool, env.userId);
            // Loud signal for the silent-skip footgun: a synthesizer is undefined
            // only when its model id is unset (admin-api didn't inject it).
            const disabledSynths = [
                !mirrorSynth         && 'mirror',
                !directionSynth      && 'direction',
                !reconciliationSynth && 'reconciliation',
            ].filter(Boolean);
            if (disabledSynths.length > 0) {
                log.warn({
                    event:  'synthesizer_disabled',
                    stages: disabledSynths,
                    reason: 'model id env var unset (PROFILE_EXTRACTOR_MODEL_ID / per-stage *_MODEL_ID)',
                    userId: env.userId,
                }, 'profile synthesizers disabled — rollup synthesis will be skipped');
            }
            await refreshUserProfileRollup(rollupRepo, env.userId, mirrorSynth, directionSynth, reconciliationSynth, careerRepo, diagnosticNarrator, diagnosticInputsRepo);
        }

        // Authoritative run cost: SUM every lane booked to prompt_invocations
        // for this repo since the run started (embeddings + enrichment + probe +
        // profile agents). Previously no single total was emitted anywhere.
        const runCost = await sumBookedCostUsd(pgPool, env.userId, env.repoFullName, runStartIso);
        // Per-agent breakdown so each cost lane is attributable — e.g.
        // titan-embed (document_embeddings), chunk-enrich (skills), profile-*.
        const costByAgent = await costBreakdownByAgent(pgPool, env.userId, env.repoFullName, runStartIso);
        log.info(
            { event: 'ingestion.cost_breakdown', repoFullName: env.repoFullName, total_usd: runCost.costUsd, by_agent: costByAgent },
            'cost breakdown by agent',
        );

        const { traceId } = rootSpan.spanContext();
        log.info({
            event:           'ingestion.complete',
            status:          'complete',
            sync_type:        syncType,
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
            cost_usd:         runCost.costUsd,
            bedrock_invocations: runCost.invocations,
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
        const friendly = friendlyIngestionError(err);
        // repo_sync_state.sync_status is the field the dashboard + onboarding UI
        // actually read (admin-api returns sync_status ?? index_status, and the
        // dispatch seeds sync_status='pending'). Profile-phase failures happen
        // before the chunk pipeline ever sets sync_status, so WITHOUT this write
        // a failed repo stays 'pending' forever. Persist a user-friendly message
        // here; keep the raw detail in repositories.error_message below.
        await syncState.markError(env.userId, env.repoFullName, friendly).catch(() => {});
        await syncRepositoryIndexStatus(
            pgPool, env.userId, env.repoFullName, 'error', errMsg.slice(0, 500),
        ).catch(() => {}); // raw detail for debugging — must not mask the original error
        throw err;
    } finally {
        rootSpan.end();
        const duration = Number(process.hrtime.bigint() - start) / 1e9;
        ingestionRuns.inc({ outcome, sync_type: syncType });
        ingestionDuration.observe({ outcome, sync_type: syncType }, duration);
        // Teardown is best-effort and time-boxed. The work + sync_status are
        // already persisted; nothing here may keep a one-shot Job alive until
        // K8s activeDeadlineSeconds kills it (which marks an otherwise-SUCCESSFUL
        // Job as Failed — see the DeadlineExceeded incident on repos that had
        // already written 'complete'). Each step gets its own bound so one
        // hung pool drain can't consume the whole budget.
        // Drain in-flight cost-record writes before the pool they share closes —
        // else the last enriched chunks' cost INSERTs race the close and are lost.
        await withTimeout(enricher?.flushCosts?.() ?? Promise.resolve(), 5_000, 'cost-flush').catch(() => { /* non-fatal */ });
        await withTimeout(
            Promise.allSettled([vectorStore.end(), syncState.end(), pgPool.end()]),
            10_000, 'db-pools',
        );
        // Group by repoFullName so dashboards show "last run per repo".
        await withTimeout(
            pushFinalMetrics(obs.registry, 'ingestion', `${env.userId}_${env.repoFullName.replace('/', '_')}`),
            8_000, 'pushgateway',
        );
        // sdk.shutdown() flushes OTel spans to Alloy.
        await withTimeout(obs.shutdown(), 10_000, 'otel-shutdown');
    }
}

// Force a prompt exit once main settles. A one-shot Job must not linger on
// stray keep-alive sockets (Bedrock/HTTP) or timers until its K8s deadline —
// that turns a finished run into a DeadlineExceeded "Failed" Job.
main()
    .then(() => process.exit(0))
    .catch((err) => {
        log.error({ err }, 'failed');
        process.exit(1);
    });
