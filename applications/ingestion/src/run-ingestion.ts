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
 *   UNIFIED_INGESTION — P1 unified ingestion flag: unset/"off" (default, today's
 *     two-job behaviour, byte-identical) | "shadow" (additionally runs the facts
 *     stage read-only and records per-layer parity against the legacy
 *     tech-extract Job's persisted evidence, in unified_parity_runs) | "on"/"1"
 *     (tarball acquisition + in-job facts stage + inline chunk stamping; the
 *     post-hoc stamp pass is skipped for this repo). A tarball failure in 'on'
 *     mode is fail-open — logs unified_fallback and falls back to 'off'.
 *   WORK_DIR — scratch directory for shadow/on tarball fetch + extract
 *     (default /tmp/ingest-work); should be an emptyDir volume in the pod spec
 *   MAX_TARBALL_BYTES — cap on the downloaded tarball size (default 200 MiB)
 *   GITHUB_SBOM_ENABLED — set to "1" to also run the GitHub dependency-graph
 *     SBOM extractor lane in the shadow/on facts stage
 *
 * Exit codes:
 *   0 — ingestion complete (sync state set to 'complete')
 *   1 — error (sync state set to 'error'); K8s backoffLimit triggers retry
 */

import {
    RdsVectorStore,
    RdsSyncStateRepository,
    TitanEmbeddingProvider,
    BedrockChunkEnricher,
    RdsOntologyGapRecorder,
    SkillOntologyRepository,
    SkillEmbeddingResolver,
    PhraseSkillResolver,
    backfillSkillEmbeddings,
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
    TechnologyEvidenceRepository,
    RdsDsaEvidenceRepository,
    RdsAiEvidenceRepository,
} from '@bedrock/shared';
import { GitHubAdapter } from './acquisition/GitHubAdapter.js';
import { FileFilter } from './knowledge/FileFilter.js';
import { ChunkerRegistry } from './knowledge/ChunkerRegistry.js';
import { IngestionPipeline } from './knowledge/IngestionPipeline.js';
import { RepoIngestionOrchestrator } from './RepoIngestionOrchestrator.js';
import { Counter, Histogram } from 'prom-client';
import { Pool } from 'pg';

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseEnv } from './env.js';
import { fetchTarball } from './acquisition/tarball/fetchTarball.js';
import { safeExtract } from './acquisition/tarball/safeExtract.js';
import { TarballRepoAdapter } from './acquisition/TarballRepoAdapter.js';
import { runFactsStage, type LaneGates } from './facts/run-facts-stage.js';
import { computeLayerParity, type EvidenceKey } from './facts/parity/layer-parity.js';
import { UnifiedParityRunRepository } from './persistence/UnifiedParityRunRepository.js';
import { buildInlineStampInputs } from './facts/inline-stamp.js';
import type { IRepoAdapter } from './acquisition/IRepoAdapter.js';
import { ProfileInputCollector } from './narrative/ProfileInputCollector.js';
import type { ProfileInputBundle } from './narrative/ProfileInputCollector.js';
import type { RepoClassification } from './util/classifyRepo.js';
import { ProfileExtractor, sha256 } from './narrative/ProfileExtractor.js';
import { RetrievalProbe } from './narrative/RetrievalProbe.js';
import { MirrorRevealSynthesizer } from './narrative/MirrorRevealSynthesizer.js';
import { DirectionSynthesizer } from './narrative/DirectionSynthesizer.js';
import { ReconciliationSynthesizer } from './narrative/ReconciliationSynthesizer.js';
import { DiagnosticNarrator } from './narrative/DiagnosticNarrator.js';
import { FileFetchCache } from './util/FileFetchCache.js';
import { classifyRepo } from './util/classifyRepo.js';
import { renderLifecycleChunks } from './util/lifecycle-chunks.js';
import { scoreProfile } from './util/scoreProfile.js';
import { refreshUserProfileRollup } from './util/refreshUserProfileRollup.js';
import { packOptionsFromEnv, reenrichSkippedChunks } from './util/reenrichSkippedChunks.js';
import { patchDeterministicProfileFacts } from './util/patchProfileFacts.js';
import { applyPostSyncProjectAction } from './util/applyPostSyncProjectAction.js';
import { normalizeEnrichmentMode } from './util/enrichmentMode.js';
import { friendlyIngestionError } from './friendly-error.js';
import { buildRepoFacts } from './facts/build-repo-facts.js';
import type { RepoFile } from '@bedrock/shared';
import { RepositoryProfileRepository } from './persistence/RepositoryProfileRepository.js';
import { RepositoryProfileEmbeddingsRepository } from './persistence/RepositoryProfileEmbeddingsRepository.js';
import type { ExtractedRepoData } from './narrative/ProfileExtractor.js';
import type { ProfileEmbeddingRow } from './persistence/RepositoryProfileEmbeddingsRepository.js';
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
            // Canonical packing (feature 004, deferred lane): ENRICH_PACK=1 resolves
            // the canonical residue N chunks per model call, so the system prompt +
            // controlled vocabulary — the bulk of live enrichment spend — bill once
            // per pack instead of once per chunk.
            ...packOptionsFromEnv(),
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

/** Resolved enrichment mode for a run. */
type EnrichmentMode = 'premium' | 'free-tier1-only' | 'disabled';

/**
 * Resolve the enrichment mode for this run from the environment and whether an
 * LLM enricher was constructed. Called once per run, logged as telemetry.
 * - `premium`: an LLM enricher is present → full Bedrock enrichment.
 * - `free-tier1-only`: no LLM enricher + ENRICHMENT_DISABLED=1 + ENRICH_TIER1=1
 *   → deterministic Tier-1 pass only, zero Bedrock calls.
 * - `disabled`: ENRICHMENT_DISABLED=1 without ENRICH_TIER1=1 → no enrichment.
 */
function resolveEnrichmentMode(enricherPresent: boolean): EnrichmentMode {
    if (enricherPresent) return 'premium';
    if (process.env['ENRICHMENT_DISABLED'] === '1' && process.env['ENRICH_TIER1'] === '1') {
        return 'free-tier1-only';
    }
    return 'disabled';
}

/**
 * Free-tier Tier-1-only enrichment pass — runs when `ENRICHMENT_DISABLED=1`
 * (no LLM enricher) AND `ENRICH_TIER1=1`. Resolves skills deterministically
 * from `file_tech_stack` with zero Bedrock calls. Best-effort, never throws.
 */
async function runTier1OnlyPass(
    pgPool: Pool,
    userId: string,
    repoFullName: string,
): Promise<void> {
    const startedAt = new Date().toISOString();
    const tier1Map = await new TechSkillMapRepository(pgPool).loadTechSkillMap().catch(() => undefined);
    try {
        const reenriched = await reenrichSkippedChunks(pgPool, undefined, {
            userId,
            repoFullName,
            tier1Map,
            // Tier-1 is a pure deterministic lookup; caching under the fixed
            // 'tier1-only' key risks stale-serving if the map changes, and there
            // is no cost benefit (zero Bedrock calls either way).
            dedupCache: false,
            deadlineMs: enrichmentDeadlineMs(),
            onProgress: (done, total) => {
                if (done % 100 === 0 || done === total) {
                    log.info({ done, total, repoFullName }, 'tier1_only_pass.progress');
                }
            },
        });
        const cost = await sumBookedCostUsd(pgPool, userId, repoFullName, startedAt, 'chunk-enrich');
        log.info(
            { event: 'tier1_only_pass.complete', repoFullName, ...reenriched, cost_usd: cost.costUsd },
            'free-tier Tier-1-only pass complete',
        );
        if (reenriched.stoppedEarly) {
            log.warn(
                { event: 'tier1_only_pass.stopped_early', repoFullName, remaining: reenriched.remaining },
                'Tier-1-only pass hit its time budget — remaining chunks left pending for the next sync',
            );
        }
    } catch (err) {
        log.warn({ err: String(err), repoFullName }, 'tier1_only_pass.failed (non-fatal)');
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

/**
 * Build the ontology-gap control-data sink (migration 109) stamped with this
 * run's context (user, repo, enrichment model, ontology size). The skill_ontology
 * count is best-effort — a query failure leaves it null and never blocks the run.
 */
async function buildGapRecorder(
    pool: Pool,
    env: { userId: string; repoFullName: string },
): Promise<RdsOntologyGapRecorder> {
    const ontologyVersion = await pool
        .query<{ n: string }>('SELECT count(*)::int AS n FROM skill_ontology')
        .then((r) => Number(r.rows[0]?.n ?? 0))
        .catch(() => null);
    return new RdsOntologyGapRecorder(pool, {
        userId:           env.userId,
        repoFullName:     env.repoFullName,
        modelId:          process.env.ENRICHMENT_MODEL_ID ?? null,
        ontologyVersion,
    });
}

async function embedProfile(
    userId: string,
    profileId: string,
    extracted: ExtractedRepoData,
    embedder: TitanEmbeddingProvider,
    embRepo: RepositoryProfileEmbeddingsRepository,
    chatbotEnabled: boolean,
): Promise<void> {
    const rows: ProfileEmbeddingRow[] = [];

    const addRow = async (
        chunkType: 'one_liner' | 'description' | 'highlight' | 'lifecycle',
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

    // Lifecycle chunks are chatbot-only (they power temporal "currently X,
    // migrated from Y" answers). Gated on the owner's chatbot_enabled flag
    // (Phase B) so non-chatbot users incur no extra embeds. The prune fix scopes
    // deletes to the batch's chunk_types, so emitting 'lifecycle' here also
    // supersedes any Phase-A manual seed idempotently.
    if (chatbotEnabled) {
        for (const sentence of renderLifecycleChunks(extracted)) {
            await addRow('lifecycle', sentence);
        }
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
    chatbotEnabled: boolean,
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
        await embedProfile(env.userId, profileId, extracted, deps.embedder, deps.embRepo, chatbotEnabled);
        stopEmbed();
        await deps.profileRepo.updateStatus(profileId, env.userId, 'completed');
        profileExtractCallsTotal().inc({ outcome: 'success' });

        log.info({
            repoFullName: env.repoFullName, classification,
            qualityScore: score, domain: extracted.domain, confidence: extracted.confidence,
        }, 'profile_extraction.complete');
    } catch (profileErr) {
        // Best-effort: the profile rollup is an enrichment layer, NOT the core
        // deliverable. A failure here (e.g. a Bedrock stream cancel/timeout) must
        // NOT abort the ingestion -- RAG embeddings + technology extraction are the
        // primary output and run after this. Mark the profile 'failed', log, and
        // return so the sync still completes. (Previously this re-threw, so a
        // single profile-LLM blip lost the entire RAG index for the repo.)
        profileExtractCallsTotal().inc({ outcome: 'failed' });
        await deps.profileRepo.updateStatus(profileId, env.userId, 'failed', String(profileErr)).catch(() => {});
        log.warn(
            { err: String(profileErr), repoFullName: env.repoFullName },
            'profile_extraction.failed_non_fatal -- continuing with RAG + technology extraction',
        );
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

// =============================================================================
// UNIFIED_INGESTION (P1 unified ingestion, Task 4)
//
// Three-state flag: 'off' (default, today's two-job behaviour, byte-
// identical) | 'shadow' (additionally runs the facts stage read-only and
// records per-layer parity against the legacy tech-extract Job's persisted
// evidence) | 'on' (tarball acquisition + in-job facts stage + inline chunk
// stamping; the post-hoc stamp pass and the standalone tech-extract Job are
// both skipped for this repo).
// =============================================================================

type UnifiedMode = 'off' | 'shadow' | 'on';

function parseUnifiedIngestionFlag(): UnifiedMode {
    const raw = process.env.UNIFIED_INGESTION;
    if (raw === '1' || raw === 'on') return 'on';
    if (raw === 'shadow') return 'shadow';
    return 'off';
}

const MAX_TARBALL_BYTES = Number(process.env.MAX_TARBALL_BYTES ?? 200 * 1024 * 1024);
/** Root scratch directory for tarball fetch + extract. One emptyDir-backed volume per pod. */
const WORK_DIR = process.env.WORK_DIR ?? '/tmp/ingest-work';

/**
 * Fetch + extract a repo tarball into a fresh, uniquely-named subdirectory of
 * WORK_DIR (so a concurrent shadow + on run, or two pods on the same node,
 * never collide). Returns undefined on ANY failure (repo_too_large, network,
 * extraction) — callers decide fallback behaviour; this never throws.
 */
async function fetchAndExtractForUnified(
    repoFullName: string,
    ref: string | undefined,
    githubToken: string,
    tag: 'shadow' | 'on',
): Promise<{ extractDir: string; resolvedSha: string | undefined } | undefined> {
    const runDir = path.join(WORK_DIR, `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const extractDir = path.join(runDir, 'tree');
    const tarPath = path.join(runDir, 'repo.tar.gz');
    try {
        await fs.mkdir(extractDir, { recursive: true });
        const resolvedSha = await fetchTarball(repoFullName, ref, githubToken, tarPath, MAX_TARBALL_BYTES);
        // safeExtract's rootDir (root-dir sha fallback) is unused here: `ref` is
        // always an already-resolved commitSha by the time this is called (see
        // resolveUnifiedAcquisition's `!commitSha` fallback-to-'off' guard below),
        // so this path never risks the literal-'HEAD' ambiguity run-tech-extract.ts
        // guards against.
        await safeExtract(tarPath, extractDir);
        return { extractDir, resolvedSha };
    } catch (err) {
        log.warn({ err: String(err), repoFullName, tag }, `unified_${tag}.tarball_failed`);
        await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
        return undefined;
    }
}

/** Best-effort recursive removal of a tarball-fetch run directory (extractDir's parent). */
async function cleanupUnifiedExtractDir(extractDir: string | undefined): Promise<void> {
    if (!extractDir) return;
    await fs.rm(path.dirname(extractDir), { recursive: true, force: true }).catch(() => {});
}

/**
 * Per-lane idempotency gates for the `on`-mode facts stage, computed from the
 * already-resolved commitSha (run-ingestion, unlike the standalone tech-
 * extract Job, always resolves HEAD via the GitHub API before any tarball
 * work — there is no raw-vs-resolved-sha ambiguity here). A force-reindex
 * bypasses all three gates, mirroring run-tech-extract's own bypass.
 */
async function computeUnifiedLaneGates(
    pool: Pool, userId: string, repoFullName: string, commitSha: string, forceReindex: boolean,
): Promise<LaneGates> {
    if (forceReindex) return { techDone: false, dsaDone: false, aiDone: false };
    try {
        const evidenceRepo = new TechnologyEvidenceRepository(pool);
        const dsaEvidenceRepo = new RdsDsaEvidenceRepository(pool);
        const aiEvidenceRepo = new RdsAiEvidenceRepository(pool);
        const [techDone, dsaDone, aiDone] = await Promise.all([
            evidenceRepo.hasEvidenceForCommit(userId, repoFullName, commitSha),
            dsaEvidenceRepo.hasDsaScanForCommit(userId, repoFullName, commitSha),
            aiEvidenceRepo.hasAiScanForCommit(userId, repoFullName, commitSha),
        ]);
        return { techDone, dsaDone, aiDone };
    } catch {
        // A gate-probe failure must never block the facts stage — worst case
        // it re-scans a commit it had already scanned.
        return { techDone: false, dsaDone: false, aiDone: false };
    }
}

/**
 * Legacy (persisted, two-job path) evidence keys for computeLayerParity's
 * LHS, scoped to this run's resolved commit sha. Without the sha filter this
 * is the historical UNION of every prior sync for the repo -- stale rows for
 * since-removed files would surface as `legacy_only_examples` and depress
 * the parity gate. The sibling tech-extract Job's insertMany DO UPDATE (see
 * TechnologyEvidenceRepository) stamps `commit_sha = EXCLUDED.commit_sha`
 * onto every still-present row on each sync, so filtering on the shadow
 * run's sha reflects only what that job found at this commit.
 *
 * Relies on the job DB role bypassing RLS (same pattern as the existing
 * apply-evidence-stamp read) -- a policy-constrained role would silently
 * return 0 rows here instead of erroring.
 */
export async function loadPersistedEvidenceKeys(
    pool: Pool, userId: string, repoFullName: string, commitSha: string,
): Promise<EvidenceKey[]> {
    const { rows } = await pool.query<{ canonical_name: string; source_layer: string; file_path: string | null }>(
        `SELECT o.canonical_name, te.source_layer, te.file_path
           FROM technology_evidence te
           JOIN technology_ontology o ON o.id = te.technology_id
          WHERE te.user_id = $1 AND te.repo_full_name = $2 AND te.commit_sha = $3`,
        [userId, repoFullName, commitSha],
    );
    return rows.map((r) => ({
        sourceLayer: r.source_layer,
        canonicalId: r.canonical_name.toLowerCase(),
        filePath:    r.file_path,
    }));
}

/**
 * UNIFIED_INGESTION=on acquisition: fetch + extract the tarball ONE time so
 * the rest of the run can read every file off local disk (adapter, profile
 * collection, orchestrator) instead of one GitHub API call per file. Tarball
 * failure (e.g. repo_too_large) or a missing commitSha is fail-open: log
 * loudly and degrade to 'off' for the rest of this run — the caller uses the
 * returned `unified`, not its input, from here on.
 */
async function resolveUnifiedAcquisition(deps: {
    unified: UnifiedMode;
    repoAdapter: GitHubAdapter;
    repoFullName: string;
    commitSha: string | null;
    githubToken: string;
}): Promise<{ unified: UnifiedMode; activeAdapter: IRepoAdapter; unifiedExtractDir?: string }> {
    const { unified, repoAdapter, repoFullName, commitSha, githubToken } = deps;
    if (unified !== 'on') return { unified, activeAdapter: repoAdapter };

    if (!commitSha) {
        log.warn({ repoFullName }, 'unified_fallback: no resolvable commit sha — falling back to legacy acquisition');
        return { unified: 'off', activeAdapter: repoAdapter };
    }

    const fetched = await fetchAndExtractForUnified(repoFullName, commitSha, githubToken, 'on');
    if (!fetched) {
        log.warn({ repoFullName }, 'unified_fallback: tarball acquisition failed — falling back to legacy acquisition');
        return { unified: 'off', activeAdapter: repoAdapter };
    }

    return {
        unified: 'on',
        activeAdapter: new TarballRepoAdapter(fetched.extractDir, fetched.resolvedSha ?? commitSha, repoAdapter),
        unifiedExtractDir: fetched.extractDir,
    };
}

/**
 * Dispatch the shadow parity pass or the on-mode persist-writes facts stage,
 * depending on `unified` — a no-op for 'off'. Runs AFTER Phase 0 (profile
 * classification informs the inline stamp) and BEFORE the orchestrator (both
 * wirings need `technology_evidence` written — 'on' for the lazy
 * stampProvider's file_tech_stack query, 'shadow' just to diff against it).
 * Both branches are internally best-effort; this never throws.
 */
async function runUnifiedFacts(deps: {
    pool: Pool;
    unified: UnifiedMode;
    unifiedExtractDir: string | undefined;
    userId: string;
    repoFullName: string;
    githubRepoId: number | null;
    githubToken: string;
    commitSha: string | null;
    forceReindex: boolean;
}): Promise<void> {
    const { pool, unified, unifiedExtractDir, userId, repoFullName, githubRepoId, githubToken, commitSha, forceReindex } = deps;

    if (unified === 'shadow') {
        await runUnifiedShadow(pool, { userId, repoFullName, githubRepoId, githubToken, commitSha });
        return;
    }
    if (unified !== 'on' || !unifiedExtractDir) return;

    try {
        const laneGates = await computeUnifiedLaneGates(pool, userId, repoFullName, commitSha as string, forceReindex);
        const factsResult = await runFactsStage({
            pool, userId, repoFullName, githubRepoId, commitSha: commitSha as string,
            extractDir: unifiedExtractDir, laneGates,
            writeMode: 'persist',
            githubSbomEnabled: process.env['GITHUB_SBOM_ENABLED'] === '1',
            githubToken,
        });
        log.info({
            event:            'unified_facts.complete',
            repoFullName,
            evidenceKeys:     factsResult.evidenceKeys.length,
            failedExtractors: factsResult.failedExtractors,
            durationMs:       factsResult.durationMs,
        }, 'unified facts stage complete');
    } catch (err) {
        // The tech lane failing does not invalidate tarball acquisition or the
        // (still-lazy) inline stampProvider — it degrades to whatever
        // technology_evidence already existed from a prior sync. Loud, but
        // non-fatal: RAG embeddings are still the primary deliverable.
        log.warn({ err: String(err), repoFullName }, 'unified_fallback: facts stage failed (non-fatal) — continuing with unified acquisition + stamp');
    }
}

/**
 * Post-hoc evidence-metadata stamp (verified-authorship + tech), skipped for
 * `unified === 'on'` runs — the pipeline already stamped every chunk inline
 * via `opts.stampProvider`, keyed off the same source tables, so this pass
 * would only redo the identical `UPDATE`. Best-effort, never fatal.
 */
async function stampEvidenceMetadataUnlessInline(
    pool: Pool, unified: UnifiedMode, userId: string, repoFullName: string,
): Promise<void> {
    if (unified === 'on') return;
    try {
        const stamped = await stampUserEvidenceMetadata(pool, userId, repoFullName);
        console.info(`[run-ingestion] evidence-metadata stamped: ${stamped} repo(s)`);
    } catch (err) {
        console.warn(`[run-ingestion] evidence-metadata stamp skipped for ${repoFullName}:`, err);
    }
}

/**
 * Shadow gate (UNIFIED_INGESTION=shadow): fetch + extract a tarball, run the
 * facts stage read-only (tech-lane only, zero writes), diff its in-memory
 * evidence keys against the legacy two-job path's persisted
 * technology_evidence, and record the per-layer comparison. Best-effort in
 * its entirety — the legacy tech-extract Job remains the source of truth
 * while this flag is 'shadow', so ANY failure here is caught, logged, and
 * MUST NOT fail the sync.
 */
export async function runUnifiedShadow(
    pool: Pool,
    deps: {
        userId: string; repoFullName: string; githubRepoId: number | null;
        githubToken: string; commitSha: string | null;
    },
): Promise<void> {
    const { userId, repoFullName, githubRepoId, githubToken, commitSha } = deps;
    if (!commitSha) {
        log.warn({ repoFullName }, 'unified_shadow.skipped_no_commit_sha');
        return;
    }
    const startMs = Date.now();
    let extractDir: string | undefined;
    try {
        const fetched = await fetchAndExtractForUnified(repoFullName, commitSha, githubToken, 'shadow');
        if (!fetched) {
            log.warn({ repoFullName }, 'unified_shadow.skipped_tarball_unavailable');
            return;
        }
        extractDir = fetched.extractDir;
        const sha = fetched.resolvedSha ?? commitSha;

        const result = await runFactsStage({
            pool, userId, repoFullName, githubRepoId, commitSha: sha, extractDir,
            writeMode: 'shadow',
            githubSbomEnabled: process.env['GITHUB_SBOM_ENABLED'] === '1',
            githubToken,
        });

        const legacyKeys = await loadPersistedEvidenceKeys(pool, userId, repoFullName, sha);
        if (legacyKeys.length === 0) {
            log.warn(
                { repoFullName, sha },
                'unified_shadow.legacy_empty: sibling tech-extract job likely not finished for this sha - parity rows recorded but interpret with care',
            );
        }
        const parity = computeLayerParity(legacyKeys, result.evidenceKeys);
        await new UnifiedParityRunRepository(pool).insertMany(userId, repoFullName, sha, parity);

        log.info({
            event: 'unified_shadow.complete',
            repoFullName,
            sha,
            durationMs: Date.now() - startMs,
            layers: parity.map((p) => ({
                sourceLayer:       p.sourceLayer,
                legacyCount:       p.legacyCount,
                unifiedCount:      p.unifiedCount,
                intersectionCount: p.intersectionCount,
            })),
            failedExtractors: result.failedExtractors,
        }, 'unified shadow parity recorded');
    } catch (err) {
        log.warn({ err: String(err), repoFullName }, 'unified_shadow.failed (non-fatal)');
    } finally {
        await cleanupUnifiedExtractDir(extractDir);
    }
}

async function main(): Promise<void> {
    let env = parseEnv();
    const start = process.hrtime.bigint();
    // Wall-clock cut-off for the end-of-run cost roll-up (prompt_invocations.invoked_at).
    const runStartIso = new Date().toISOString();
    let outcome: 'success' | 'failed' = 'failed';

    // UNIFIED_INGESTION (P1 Task 4) — parsed once. `unified` is mutable: an
    // 'on' run that fails tarball acquisition degrades to 'off' for the rest
    // of this run (fail-open — see the on-mode wiring below).
    let unified: UnifiedMode = parseUnifiedIngestionFlag();

    log.info({
        userId:       env.userId,
        repoFullName: env.repoFullName,
        forceReindex: env.forceReindex,
        unifiedIngestion: unified,
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
        // Pool must cover the deferred-enrichment worker fan-out. reenrichSkippedChunks
        // runs up to `concurrency` (default 10) workers in parallel, each doing a
        // writeSkills UPDATE + a fire-and-forget cost-record + a WS5 cache write — all
        // from this pool. At max:3, 10 workers contended for 3 connections and most
        // could not acquire one in time; the per-chunk error was swallowed (silent
        // catch) and the chunk stayed `pending`. On a force-reindex of 2,511 chunks
        // ~46% failed this way (db_errors=0 — not the server, the client pool). Sized
        // to concurrency + headroom for the cost/cache writes; one ingestion Job runs
        // at a time, well under the instance max_connections.
        max:      16,
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

    // UNIFIED_INGESTION=on acquisition: fetch + extract the tarball ONE time
    // and read every file off local disk for the rest of the run (adapter,
    // profile collection, orchestrator) instead of one GitHub API call per
    // file. Fail-open — see resolveUnifiedAcquisition's doc comment.
    const acquisition = await resolveUnifiedAcquisition({
        unified, repoAdapter, repoFullName: env.repoFullName, commitSha, githubToken: env.githubToken,
    });
    unified = acquisition.unified;
    const activeAdapter: IRepoAdapter = acquisition.activeAdapter;
    // Set only when the on-mode tarball was extracted; cleaned up in the outer finally.
    const unifiedExtractDir = acquisition.unifiedExtractDir;

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

        // Control-data sink (migration 109): record skill phrases that did not
        // canonicalise so the ontology can be grown from real usage. Best-effort
        // — only captures when the fuzzy resolver ran (premium path) and still
        // returned no canonical. Capture failures never affect ingestion.
        const gapRecorder = await buildGapRecorder(pgPool, env);

        enricher = BedrockChunkEnricher.fromEnvironment(
            {
                pool:        pgPool,
                userId:      env.userId,
                repoName:    env.repoFullName,
                syncKind:    syncType,
                githubRepoId: env.githubRepoId,
            },
            skillAliasToCanonical,
            resolveSkill,
            gapRecorder,
        );
    }

    const retrievalProbe = RetrievalProbe.fromEnvironment(pgPool, env.userId, env.repoFullName);

    // Resolve enrichment mode once here (single source of truth) so the stored
    // value on repo_sync_state.enrichment_mode matches the log event emitted later.
    const enrichmentMode = resolveEnrichmentMode(!!enricher);

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
        enrichmentMode: normalizeEnrichmentMode(enrichmentMode),
        enrichmentModel: enricher?.modelId ?? null,
    });

    const repositoryId  = await resolveRepositoryId(pgPool, env.userId, env.repoFullName);
    if (!repositoryId) {
        console.warn(`[run-ingestion] no repositories row for ${env.repoFullName}; structured commit/PR persistence will be skipped`);
    }
    const activityStore  = new RdsRepoActivityStore(pgPool, githubRepoId);
    const fileStateStore = new RdsRepoFileStateRepository(pgPool, githubRepoId);

    // Inline stamping (P1 Task 4): only when 'on' mode actually acquired via
    // tarball (unified may have degraded to 'off' above). Lazy —
    // buildInlineStampInputs is invoked once, inside the pipeline's
    // embed+upsert phase, after commits are persisted.
    const stampProvider = unified === 'on'
        ? () => buildInlineStampInputs(pgPool, env.userId, env.repoFullName)
        : undefined;

    const orchestrator = new RepoIngestionOrchestrator(
        activeAdapter, fileFilter, chunkerReg, pipeline,
        {
            activityStore,
            repositoryId: repositoryId ?? undefined,
            syncStateSignalSink: syncState,
            fileStateStore,
            watermarkStore: syncState,
            stampProvider,
        },
    );

    const fileCache        = new FileFetchCache();
    const profileRepo      = new RepositoryProfileRepository(pgPool);
    const rollupRepo       = new RdsUserProfileRollupRepository(pgPool);
    const embRepo          = new RepositoryProfileEmbeddingsRepository(pgPool);
    const profileExtractor = new ProfileExtractor(env.profileExtractorModelId, pgPool);
    // ProfileInputCollector now takes the IRepoAdapter seam so 'on' mode
    // (unified acquisition) reads README/manifest/changelog/workflow probes
    // off the already-extracted tarball (TarballRepoAdapter.fetchFile, local
    // disk) instead of re-downloading each file over the GitHub API — the
    // tarball fetch stays the ONE download for file content. getRepoMeta and
    // listCommits still delegate to the real GitHubAdapter (no tarball-local
    // representation). `prefetchedFiles` below comes from `activeAdapter` too,
    // avoiding a duplicate tree fetch.
    const profileCollector = new ProfileInputCollector(activeAdapter, fileCache);

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
            prefetchedFiles = await activeAdapter.listFiles(env.repoFullName);
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
            // Owner opt-in (Phase B): emit chatbot lifecycle chunks only when the
            // portfolio owner has enabled the chatbot. Best-effort; defaults off so
            // a lookup failure never adds chatbot-only work.
            const chatbotEnabled = await pgPool
                .query<{ chatbot_enabled: boolean }>('SELECT chatbot_enabled FROM users WHERE id = $1::uuid', [env.userId])
                .then((r) => r.rows[0]?.chatbot_enabled === true)
                .catch(() => false);
            // Best-effort: doExtractAndEmbed marks the profile 'failed' and returns
            // (never throws) -- a profile-rollup failure must not abort the run, so
            // RAG embeddings + technology extraction below still complete.
            await doExtractAndEmbed({ profileRepo, profileExtractor, embedder, embRepo }, env, bundle, classification, profileInputHash, chatbotEnabled);
        }

        // ── UNIFIED_INGESTION shadow/on facts stage ──────────────────────────────
        // Runs AFTER Phase 0 (profile classification informs the inline stamp) and
        // BEFORE the orchestrator (both wirings need `technology_evidence` written
        // — 'on' for the lazy stampProvider's file_tech_stack query, 'shadow' just
        // to diff against it). No-op for 'off'; internally best-effort.
        await runUnifiedFacts({
            pool: pgPool, unified, unifiedExtractDir,
            userId: env.userId, repoFullName: env.repoFullName, githubRepoId: env.githubRepoId,
            githubToken: env.githubToken, commitSha, forceReindex: env.forceReindex,
        });

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

        // Materialise the per-repo repo_facts fact sheet (migration 121) — tech
        // lanes + signal-derived concepts + component role, read by case-study /
        // project synthesis instead of re-querying technology_evidence each time.
        // Reads already-persisted tech evidence + role signals; best-effort, never fatal.
        try {
            await buildRepoFacts(pgPool, env.userId, env.repoFullName);
        } catch (err) {
            console.warn(`[run-ingestion] repo_facts build skipped for ${env.repoFullName}:`, err);
        }

        // Stamp evidence metadata (verified-authorship + tech) onto this repo's chunks
        // so filter-then-rank retrieval can gate fork/low-trust evidence + pre-filter by
        // tech. Skipped for 'on' runs — the pipeline already stamped every chunk
        // inline via opts.stampProvider, keyed off the SAME source tables.
        await stampEvidenceMetadataUnlessInline(pgPool, unified, env.userId, env.repoFullName);

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
        // Free-tier branch: no LLM enricher, but Tier-1 deterministic skills
        // (file_tech_stack → canonical) are still available at zero cost.
        // enrichmentMode was resolved and hoisted before pipeline construction.

        const enrichCost = await sumBookedCostUsd(pgPool, env.userId, env.repoFullName, runStartIso, 'chunk-enrich');
        log.info(
            { event: 'enrichment.mode', mode: enrichmentMode, cost_usd: enrichCost.costUsd },
            'resolved enrichment mode for this run',
        );

        if (deferEnrichment && enricher) {
            await runDeferredEnrichment(pgPool, enricher, env.userId, env.repoFullName);
        } else if (enrichmentMode === 'free-tier1-only') {
            await runTier1OnlyPass(pgPool, env.userId, env.repoFullName);
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

        // Apply any Add-time project intent (build / link) that was stamped when
        // the user added this repo before its first sync. Best-effort -- never throws.
        const projectAction = await applyPostSyncProjectAction(pgPool, env.userId, env.repoFullName);
        if (projectAction !== 'none') {
            log.info({ repoFullName: env.repoFullName, projectAction }, 'post_sync_project_action.applied');
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
        // UNIFIED_INGESTION=on's tarball extract dir — best-effort, WORK_DIR is an
        // emptyDir volume that outlives this process otherwise.
        await cleanupUnifiedExtractDir(unifiedExtractDir);
        // Teardown is best-effort and time-boxed. The work + sync_status are
        // already persisted; nothing here may keep a one-shot Job alive until
        // K8s activeDeadlineSeconds kills it (which marks an otherwise-SUCCESSFUL
        // Job as Failed — see the DeadlineExceeded incident on repos that had
        // already written 'complete'). Each step gets its own bound so one
        // hung pool drain can't consume the whole budget.
        // Drain in-flight cost-record writes before the pool they share closes —
        // else the last enriched chunks' cost INSERTs race the close and are lost.
        await withTimeout(enricher?.flushCosts?.() ?? Promise.resolve(), 5_000, 'cost-flush').catch(() => { /* non-fatal */ });
        // Flush buffered ontology-gap control data on the same shared pool, before close.
        await withTimeout(enricher?.flushGaps?.() ?? Promise.resolve(), 5_000, 'gap-flush').catch(() => { /* non-fatal */ });
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

// Only auto-execute when run as the K8s Job entrypoint, not when imported by tests.
if (require.main === module) {
    // Force a prompt exit once main settles. A one-shot Job must not linger on
    // stray keep-alive sockets (Bedrock/HTTP) or timers until its K8s deadline —
    // that turns a finished run into a DeadlineExceeded "Failed" Job.
    main()
        .then(() => process.exit(0))
        .catch((err) => {
            log.error({ err }, 'failed');
            process.exit(1);
        });
}
