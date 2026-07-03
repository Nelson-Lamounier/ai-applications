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
import type { StrategistPipelineContext, StrategistResearchResult, StructuredResumeData, CoverLetter, GroundingMode } from '@bedrock/shared';
import type { Pool } from 'pg';
import { bootstrapK8sObservability, pushFinalMetrics, BedrockGroundingVerifier, BedrockProseLinter, PgSemanticCache, OutputSanitiser, recordInvocationToRds, RoleOntologyRepository, TitanEmbeddingProvider, TechnologyOntologyRepository, SkillOntologyRepository, SkillEmbeddingResolver, PhraseSkillResolver, canonicaliseSkills, RdsVectorStore } from '@bedrock/shared';
import type { JdSignal } from '@bedrock/shared';
import { Counter, Histogram } from 'prom-client';
import { extractResumeProseSections } from './lib/resume-prose.js';

import { executeResearchAgent, KB_CONTEXT_SEPARATOR, sanitiseJobDescription } from './agents/research-agent.js';
import { executeStrategistAgent } from './agents/strategist-agent.js';
import { resolveRoleFamilies, stageJdLearning } from './agents/resolve-role-families.js';
import { formatRoleEvidence } from './agents/role-evidence-block.js';
import { loadProjectEvidenceBlock, loadProjectLaneIndex } from './agents/project-evidence-block.js';
import { loadAchievementEvidence } from './agents/achievement-evidence.js';
import { loadProfileIntelligenceBlock } from './agents/profile-intelligence-block.js';
import { loadEducation, formatEducation, loadCertifications, formatCertifications, loadCareerHistory, formatExperienceFacts } from './agents/career-history.js';
import { extractJobDescription, extractJdSignal } from './agents/jd-extractor.js';
import { buildYearsGap } from './agents/years-gap.js';
import { guardCoverLetter } from './agents/cover-letter-guard.js';
import { guardResume } from './agents/resume-guard.js';
import { annotateGapCauses } from './lib/gap-cause.js';
import { applyLengthBudget } from './ats/length-budget.js';
import { parseEnv, isFreeMode }   from './env.js';
import { getPool, closePool }     from './lib/pg.js';
import { classifyCitedPaths }     from './lib/path-grounding.js';
import { loadIngestedPaths }      from './lib/path-grounding-loader.js';
import {
    updatePipelineRun,
    updatePipelineRunMetadata,
    updateJobApplicationStatus,
    persistTailoredResume,
} from './lib/pipeline-runs.js';
import { S3Client } from '@aws-sdk/client-s3';
import { renderCheckAndStoreAts } from './ats/run-ats-check.js';
import type { AtsCheckResult } from './ats/ats-check.schema.js';
import { buildSkillEvidenceLedger } from './ats/skill-evidence-ledger.js';
import { canonicalJdSkills } from './ats/canonical-jd-skills.js';
import { splitAttainable } from './ats/attainable.js';
import { demoteMisattributedVendors } from './ats/vendor-provenance.js';
import { buildCodeStackContext, demoteCodeContradictedMatches } from './ats/code-truth.js';
import { buildRepoProfiles, buildRepoProfileContext, persistRepoProfiles, type RepoProfile } from './ats/repo-profile.js';
import { detectStaleMigrations, reframeStaleMigrations } from './ats/migration-reframe.js';
import { buildRetrievalPrefilter } from './ats/retrieval-prefilter.js';
import { buildProvenanceRows, persistEvidenceProvenance, buildRepoQualityRows, persistRepoEvidenceQuality } from './lib/evidence-provenance.js';
import { extractNumbers, stripUngroundedNumbers } from './ats/number-provenance.js';
import { surfaceKeywords } from './agents/surface-keywords.js';
import { formatTechTransferContext } from './ats/tech-transfer-context.js';
import { attachCodeEvidence } from './ats/tool-evidence-retrieval.js';
import { attachSourceLanes } from './ats/evidence-lane.js';
import { applyDegreeReconcile } from './ats/education-reconcile.js';
import { applyYearsGapReconcile } from './ats/years-gap-reconcile.js';
import { runFreeTier }             from './free/run-free.js';
import { gatherFreeEvidence }      from './free/gather-evidence.js';
import { bedrockFreeResumeWriter } from './agents/free-resume-writer.js';
import { querySingleRds }          from './agents/research-agent.js';

// Default 'flag' — serve the real analysis and surface ungrounded claims via
// telemetry, rather than 'block' replacing a cited analysis with a one-line stub.
// Set GROUNDING_MODE=block to restore strict replacement for a stricter tier.
const groundingVerifier = new BedrockGroundingVerifier({
    mode: (process.env['GROUNDING_MODE'] as GroundingMode) ?? 'flag',
});

/** Shared Postgres+pgvector semantic response cache (fail-open). */
const semanticCache = PgSemanticCache.fromEnvironment();
/** Redacts infra identifiers from the failure message before it reaches the client. */
const outputSanitiser = new OutputSanitiser();

/**
 * Query-side phrase -> canonical resolver — the read-only twin of the ingestion
 * enricher's resolver. No self-heal backfill (ingestion owns embedding the
 * ontology); this just embeds a JD skill phrase and maps it to its nearest
 * canonical so the query side of `d.skills && query.skills` resolves like the
 * corpus side. Same SKILL_MATCH_THRESHOLD as the corpus side for symmetry.
 */
function buildQuerySkillResolver(pool: Pool): (phrase: string) => Promise<string | null> {
    const threshold = process.env['SKILL_MATCH_THRESHOLD']
        ? Number.parseFloat(process.env['SKILL_MATCH_THRESHOLD'])
        : undefined;
    const resolver = new SkillEmbeddingResolver(pool, threshold);
    const phraseResolver = new PhraseSkillResolver(TitanEmbeddingProvider.fromEnvironment(), resolver);
    return (phrase) => phraseResolver.resolve(phrase);
}

/**
 * Build the filter-then-rank retrieval prefilter, canonicalising the JD's
 * skills through the SAME cascade the corpus side uses (alias -> embedding
 * nearest-canonical -> raw) so BOTH sides of `d.skills && query.skills` resolve
 * to identical canonicals — without this the overlap silently misses any phrase
 * the corpus collapsed by embedding. Env-gated (RETRIEVAL_PREFILTER=on); absent
 * => today's pure-vector retrieval. Read-only + fail-open. Extracted from main()
 * to keep its complexity bounded.
 */
async function buildQueryRetrievalPrefilter(
    pool: Pool,
    jdExtraction: JdSignal,
    techGroups: ReadonlyArray<ReadonlyArray<string>>,
    aliasToCanonical: ReadonlyMap<string, string>,
): Promise<ReturnType<typeof buildRetrievalPrefilter> | undefined> {
    if (process.env['RETRIEVAL_PREFILTER'] !== 'on') return undefined;
    const ti = jdExtraction.technologyInventory;
    const querySkills = await canonicaliseSkills(
        [...jdExtraction.requiredSkills, ...jdExtraction.preferredSkills],
        await new SkillOntologyRepository(pool).loadAliasToCanonicalMap().catch(() => new Map<string, string>()),
        buildQuerySkillResolver(pool),
    );
    return buildRetrievalPrefilter(
        querySkills,
        [...ti.tools, ...ti.languages, ...ti.frameworks, ...ti.infrastructure, ...jdExtraction.retrievalKeywords],
        techGroups, aliasToCanonical,
    );
}

/** S3 client for canonical resume PDF storage. */
const s3 = new S3Client({});

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
/** Count of file-path citations in the analysis that are NOT in the user's
 *  ingested document_embeddings — i.e. hallucinated/inferred source paths. */
const ungroundedPaths = new Counter({
    name:       'job_strategist_ungrounded_paths_total',
    help:       'File-path citations in the analysis not found in ingested document_embeddings.',
    labelNames: ['operation'] as const,
    registers:  [obs.registry],
});

// Resume prose-quality verdicts (stop-slop). status ∈ PASS|FAIL|error|skipped.
const resumeProse = new Counter({
    name:       'job_strategist_resume_prose_total',
    help:       'Strategist resume/cover prose-quality verdicts by status.',
    labelNames: ['status'] as const,
    registers:  [obs.registry],
});
const coverLetterViolations = new Counter({
    name:      'job_strategist_cover_letter_violations_total',
    help:      'Cover-letter guard violations caught (and rewritten) by code.',
    labelNames: ['code'] as const,
    registers:  [obs.registry],
});
const resumeViolationsMetric = new Counter({
    name:       'job_strategist_resume_violations_total',
    help:       'Resume guard violations caught (and rewritten) by code.',
    labelNames: ['code'] as const,
    registers:  [obs.registry],
});
const atsFeedback = new Counter({
    name:       'job_strategist_ats_feedback_total',
    help:       'ATS feedback loop outcomes: fired (re-write ran), passed (no attainable missing), skipped (re-write not run).',
    labelNames: ['outcome'] as const,
    registers:  [obs.registry],
});
const gapCauseMetric = new Counter({
    name:       'job_strategist_gap_cause_total',
    help:       'Research gap causes: kb_present_not_retrieved (retrieval tuning lead) vs kb_no_evidence (document-or-build signal).',
    labelNames: ['cause'] as const,
    registers:  [obs.registry],
});
// Prose linting runs in 'flag' mode only — telemetry on AI-tell language in the
// generated resume + cover letter; never alters or blocks the persisted output.
const resumeProseLinter = new BedrockProseLinter({ mode: 'flag' });

/**
 * Lint the Strategist's resume + cover-letter prose for AI-tell language and
 * record the verdict (metric + log). Flag-mode + fail-open: pure observability —
 * never alters persisted output and never throws into the pipeline.
 */
async function lintResumeProse(
    pool: Pool,
    env: ReturnType<typeof parseEnv>,
    resume: StructuredResumeData | null,
    coverLetter: CoverLetter | null,
): Promise<void> {
    try {
        const sections = extractResumeProseSections(resume, coverLetter);
        if (sections.length === 0) {
            resumeProse.inc({ status: 'skipped' });
            return;
        }
        const q = await resumeProseLinter.lint(
            { sections, stage: 'applied' },
            { pool, userId: env.userId },
        );
        resumeProse.inc({ status: q.status });
        if (q.status === 'FAIL') {
            log.warn({
                pipelineRunId: env.pipelineRunId,
                applicationId: env.applicationId,
                proseScore:    q.score,
                proseIssues:   q.issues,
            }, 'resume_prose_below_threshold');
        }
    } catch (e) {
        resumeProse.inc({ status: 'error' });
        log.warn({
            pipelineRunId: env.pipelineRunId,
            err:           (e as Error).message,
        }, 'resume_prose_lint_failed (non-fatal)');
    }
}

/**
 * Record the run's evidence provenance (Phase 1) + per-repo quality rollup (Phase 2)
 * into their queryable tables. Flattens the retrieval trace + usage attribution
 * (cited / demoted / never-used) already computed upstream. Pure observability
 * side-channel — fail-open, never gates the run.
 */
interface RunProvenanceInputs {
    readonly pool: Pool;
    readonly env: { pipelineRunId: string; userId: string };
    readonly researchData: StrategistResearchResult;
    readonly matching: { verifiedMatches: ReadonlyArray<{ evidenceFiles?: string[] }>; partialMatches: ReadonlyArray<{ evidenceFiles?: string[] }> };
    readonly demotions: ReadonlyArray<{ evidenceFiles: string[] }>;
    readonly contradictions: ReadonlyArray<{ evidenceFiles: string[] }>;
    readonly codeTechByRepo: ReadonlyMap<string, ReadonlySet<string>>;
    readonly repoProfiles: ReadonlyArray<RepoProfile>;
}

async function recordRunProvenance(args: RunProvenanceInputs): Promise<void> {
    const { pool, env, researchData, matching, demotions, contradictions, codeTechByRepo, repoProfiles } = args;
    try {
        const verifiedFiles = new Set<string>();
        for (const m of matching.verifiedMatches) for (const f of m.evidenceFiles ?? []) verifiedFiles.add(f);
        const partialFiles = new Set<string>();
        for (const m of matching.partialMatches) for (const f of m.evidenceFiles ?? []) partialFiles.add(f);
        const demotedFiles = new Map<string, 'vendor_provenance' | 'code_truth'>();
        for (const d of demotions) for (const f of d.evidenceFiles) demotedFiles.set(f, 'vendor_provenance');
        for (const c of contradictions) for (const f of c.evidenceFiles) demotedFiles.set(f, 'code_truth');
        const provRows = buildProvenanceRows({
            kbContext: researchData.kbContext ?? '',
            floor: researchData.kbRetrievalStats?.floor ?? 0.2,
            verifiedFiles, partialFiles, demotedFiles,
        });
        const meta = { pipelineRunId: env.pipelineRunId, userId: env.userId };
        const persisted = await persistEvidenceProvenance(pool, {
            ...meta, targetRole: researchData.targetRole, targetCompany: researchData.targetCompany ?? '', agent: 'research',
        }, provRows);
        const qualityRows = buildRepoQualityRows(provRows, codeTechByRepo);
        await persistRepoEvidenceQuality(pool, { ...meta, targetRole: researchData.targetRole }, qualityRows);
        const profilesPersisted = await persistRepoProfiles(pool, meta, repoProfiles);
        log.info({ pipelineRunId: env.pipelineRunId, provenanceRows: persisted, repoQualityRows: qualityRows.length, repoProfiles: profilesPersisted }, 'evidence_provenance_persisted');
    } catch (e) {
        log.warn({ pipelineRunId: env.pipelineRunId, err: (e as Error).message }, 'evidence_provenance_persist_failed (non-fatal)');
    }
}

/**
 * Build the semantic-cache kb_tag for a user. Fail-open: on any DB error
 * fall back to a model-only tag so the cache still partitions by model.
 */
async function cacheTagFor(pool: Pool, userId: string): Promise<string> {
    const model = process.env['STRATEGIST_MODEL'] ?? 'default';
    try {
        const r = await pool.query<{ t: string }>(
            `SELECT COALESCE(MAX(last_synced_at)::text, '') || COALESCE((MAX(kb_quality_breakdown->>'version')), '') AS t FROM repo_sync_state WHERE user_id = $1`,
            [userId]);
        return `${r.rows[0]?.t ?? ''}:${model}`;
    } catch { return `:${model}`; }
}

/**
 * Verify that file-path citations in the final analysis exist in the user's
 * ingested `document_embeddings`. The text-level grounding verifier confirms
 * claim *content* but not *path existence*, so a real-tech / invented-path
 * citation (e.g. `api/admin-api/src/**` inferred from prose) can slip through.
 *
 * Fail-open: any DB/parse error returns an empty classification so the run
 * never hard-fails on this advisory check. Returns the classification for
 * stashing on pipeline_runs.metadata so admin-api / the UI can surface a
 * "these cited paths were not found in your ingested repos" warning.
 */
async function verifyAnalysisPaths(
    pool: Pool,
    userId: string,
    analysisXml: string,
    pipelineRunId: string,
): Promise<{ grounded: string[]; ungrounded: string[] }> {
    try {
        const ingested = await loadIngestedPaths(pool, userId);
        const { grounded, ungrounded } = classifyCitedPaths(analysisXml, ingested);
        if (ungrounded.length > 0) {
            ungroundedPaths.inc({ operation: 'analyse' }, ungrounded.length);
            log.warn({
                pipelineRunId,
                ungroundedPaths: ungrounded,
                groundedCount:   grounded.length,
            }, 'analysis_cited_ungrounded_paths');
        }
        return { grounded, ungrounded };
    } catch (e) {
        log.warn({
            pipelineRunId,
            error: (e as Error).message,
        }, 'Path-grounding check failed — skipping (fail-open)');
        return { grounded: [], ungrounded: [] };
    }
}

export async function main(): Promise<void> {
    const env  = parseEnv();
    const pool = getPool(env.pg);

    // ── Free-tier fast path — early return, never falls through to the paid pipeline ──
    if (isFreeMode(env)) {
        const store = RdsVectorStore.fromEnvironment();
        try {
            await runFreeTier(pool, env, {
                extractJdSignal,
                gather: (p, e, jd) => gatherFreeEvidence(p, e, jd, {
                    retrieve: (query) => querySingleRds(query, e.userId, store),
                }),
                writer:        bedrockFreeResumeWriter,
                aliasMap:      (p) => new SkillOntologyRepository(p).loadAliasToCanonicalMap(),
                persistResume: persistTailoredResume,
                persistMeta:   updatePipelineRunMetadata,
                setStatus:     updateJobApplicationStatus,
                complete:      updatePipelineRun,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const clientMessage = outputSanitiser.sanitise(message).slice(0, 500);
            await updatePipelineRun(pool, env.pipelineRunId, 'failed', clientMessage)
                .catch(() => { /* swallow — already failing */ });
            await updateJobApplicationStatus(pool, env.applicationId, 'failed')
                .catch(() => { /* swallow — already failing */ });
            throw err;
        } finally {
            await closePool();
        }
        return; // free path is terminal — never falls through to the paid pipeline
    }

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
    // Single authoritative JD sanitisation (injection-strip + PII-scrub) at
    // pipeline entry. Every consumer — JD-extractor, Research, semantic cache —
    // inherits this neutralised value via ctx.jobDescription, instead of each
    // re-deriving it (and the extractor/cache previously skipping injection-strip).
    const { clean: cleanJobDescription, warnings: jdWarnings, injectionDetected } =
        sanitiseJobDescription(env.jobDescription);
    if (injectionDetected) {
        log.warn({ pipelineRunId: env.pipelineRunId }, 'JD injection attempt detected — proceeding with sanitised input');
    }
    for (const w of jdWarnings) {
        log.warn({ pipelineRunId: env.pipelineRunId, warning: w }, 'jd_sanitise_warning');
    }

    const ctx: StrategistPipelineContext = {
        pipelineId:        env.pipelineId,
        operation:         'analyse',
        applicationSlug:   env.applicationSlug,
        jobDescription:    cleanJobDescription,
        targetCompany:     env.targetCompany,
        targetRole:        env.targetRole,
        resumeId:          env.resumeId,
        resumeData:        resumeData as StructuredResumeData | null,
        interviewStage:    'applied',
        bucket:            process.env['S3_BUCKET'] ?? '',
        environment:       env.environment,
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
        startedAt:         new Date().toISOString(),
        userId:            env.userId,
        onInvocationComplete: recordInvocationToRds(pool, 'job-strategist', { applicationId: env.applicationId }),
    };

    try {
        await updatePipelineRun(pool, env.pipelineRunId, 'researching');
        await updateJobApplicationStatus(pool, env.applicationId, 'analysing');

        // ── Semantic cache short-circuit (fail-open) ──────────────────────
        // The JD is PII-scrubbed before it ever becomes the cache key so no
        // raw PII reaches the embedding model or the cache table. Any cache
        // failure degrades to a normal (uncached) run — never a hard-fail.
        // A hit reproduces the exact terminal run-state of a successful run.
        // Scope on the user ONLY. targetRole/targetCompany are free-text user
        // inputs ("Sr" vs "Senior", trailing spaces), so keying the scope on
        // them partitioned near-identical applications into disjoint cache rows
        // (live data: 1 row, 0 hits ever). They still take part in matching,
        // but semantically — prepended to the query text below, where the
        // cosine threshold tolerates phrasing variance instead of requiring
        // byte equality.
        const cacheScope = `jobstrat:${env.userId}`;
        // Fail-open: any throw from cacheTagFor degrades to a model-only tag so
        // the cache still partitions by model and the run never hard-fails.
        let cacheTag = `:${process.env['STRATEGIST_MODEL'] ?? 'default'}`;
        try { cacheTag = await cacheTagFor(pool, env.userId); } catch { /* fail-open: model-only tag */ }
        // JD already sanitised once at entry. Role/company lead the text so two
        // runs of the same JD against different roles stay distinguishable.
        const jdForCache = `${env.targetRole} @ ${env.targetCompany}\n${ctx.jobDescription}`;
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
        if (cached.hit && cached.response && typeof (cached.response as { analysis?: { analysisXml?: unknown } }).analysis?.analysisXml === 'string') {
            const cr = cached.response as {
                analysis: {
                    analysisXml: string;
                    tailoredResumeData?: unknown;
                    archetypeSelection?: { selectedArchetype?: string | null };
                    [k: string]: unknown;
                };
                research: unknown;
            };
            await updatePipelineRunMetadata(pool, env.pipelineRunId, {
                analysis: cr.analysis,
                research: cr.research,
            });
            // Reproduce the exact terminal state of a normal run: persist the
            // cached tailored resume so admin-api detail and the downstream
            // coach Job see a resume row. Older cached entries predate this
            // field — when absent, proceed without it (matches a run that
            // produced no resume). Mirrors the normal success-path call.
            if (cr.analysis?.tailoredResumeData) {
                await persistTailoredResume(pool, {
                    applicationId:  env.applicationId,
                    userId:         env.userId,
                    pipelineId:     env.pipelineId,
                    targetRole:     env.targetRole,
                    archetype:      cr.analysis?.archetypeSelection?.selectedArchetype ?? null,
                    tailoredResume: cr.analysis.tailoredResumeData,
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

        // Independent pre-research inputs, loaded CONCURRENTLY (were sequential):
        //  - project case studies (citeable evidence for grounding + resume bullets)
        //  - education facts (verbatim degree/institution — no hallucinated schools)
        //  - careerEntries: loaded ONCE here and shared by the experience-facts block
        //    AND the Research agent's career history (was loaded twice)
        //  - JD-extractor: structured JD signal that sharpens KB retrieval
        // All fail-open.
        const [projectEvidenceBlock, projectLaneIndex, profileIntelligenceBlock, educationEntries, certificationEntries, careerEntries, jdExtraction, achievementEvidenceBlock] = await Promise.all([
            loadProjectEvidenceBlock(pool, ctx.userId),
            loadProjectLaneIndex(pool, ctx.userId),
            loadProfileIntelligenceBlock(pool, ctx.userId),
            loadEducation(pool, ctx.userId).catch(() => []),
            loadCertifications(pool, ctx.userId).catch(() => []),
            loadCareerHistory(pool, ctx.userId).catch(() => []),
            extractJobDescription(ctx.jobDescription, ctx),
            loadAchievementEvidence(pool, ctx.userId),
        ]);
        // Candidate grounding fed to research + strategist: documented project case
        // studies PLUS the code-grounded Profile Intelligence (direction / undersold
        // strengths / unsupported claims). Both fail-open to '' independently.
        const candidateGroundingBlock = [projectEvidenceBlock, profileIntelligenceBlock].filter(Boolean).join('\n\n');
        const educationBlock      = formatEducation(educationEntries);
        const certificationsBlock = formatCertifications(certificationEntries);
        const experienceFactsBlock = formatExperienceFacts(careerEntries);

        // Role-ontology grounding — translate experience into target-role vocabulary. Fail-open.
        const roleRepo = new RoleOntologyRepository(pool);
        const companyFraming = await roleRepo.loadCompanyFraming().catch(() => new Map());
        const resolved = await resolveRoleFamilies(
            pool, ctx.userId,
            (careerEntries ?? []).map((c) => ({ title: c.title, company: c.company, highlights: c.highlights })),
            roleRepo,
        ).catch(() => []);
        // B1 — stage JD demand-side signal: record JD required skills + tools as
        // vocabulary candidates for the families matched from the candidate's career.
        void stageJdLearning(
            roleRepo, ctx.userId, resolved,
            jdExtraction.requiredSkills,
            jdExtraction.technologyInventory.tools,
        ).catch(() => undefined);
        const roleEvidenceBlock = formatRoleEvidence(resolved, companyFraming);
        // Flatten vocabulary groups from resolved role families for ontology-tier ATS matching.
        const familyVocab = resolved
            .map((rr) => rr.family?.vocabulary ?? [])
            .filter((v) => v.length > 0);

        // Tech-ontology grounding — load transfer groups + alias map ONCE (fail-open).
        // Prefer the explicit relationship graph; fall back to category groups when sparse.
        const techRepo = new TechnologyOntologyRepository(pool);
        const [techTransferGroups, techCategoryGroups, techAliasMap, codeTechByRepo, succeedsEdges, aliasToCanonical, archetypeSignals, repoFilePaths, evidenceTopology, canonicalToCodeFiles] = await Promise.all([
            techRepo.loadTransferGroups().catch(() => [] as string[][]),
            techRepo.loadCategoryGroups().catch(() => [] as string[][]),
            techRepo.loadAliasMap().catch(() => new Map<string, string>()),
            techRepo.loadRepoCodeTech(env.userId).catch(() => new Map<string, Set<string>>()),
            techRepo.loadSucceedsEdges().catch(() => new Map<string, Set<string>>()),
            techRepo.loadAliasToCanonicalMap().catch(() => new Map<string, string>()),
            techRepo.loadRepoArchetypeSignals(env.userId).catch(() => new Map<string, Record<string, boolean>>()),
            techRepo.loadRepoFilePaths(env.userId).catch(() => new Map<string, Set<string>>()),
            techRepo.loadRepoEvidenceTopology(env.userId).catch(() => new Map<string, Record<string, unknown>>()),
            techRepo.loadCanonicalToCodeFiles(env.userId).catch(() => new Map<string, string[]>()),
        ]);
        const techGroups = techTransferGroups.length > 0 ? techTransferGroups : techCategoryGroups;

        // A5 — build grounded tech-transfer context for the matcher persona.
        // Lists only the groups relevant to THIS JD's tools (not the full ontology).
        const jdTools = [
            ...jdExtraction.technologyInventory.tools,
            ...jdExtraction.technologyInventory.languages,
        ];
        const techTransferContext = formatTechTransferContext(jdTools, techGroups, techAliasMap);
        // Doc-vs-code drift + repo identity: the authoritative current code stack per repo
        // AND each repo's deterministic profile (cdk-infra/k8s-platform/…, what it provisions).
        // Folded into one grounding block so the matcher prefers code over stale docs and
        // attributes work to the right repo (e.g. cdk-monitoring IS the EKS-via-CDK infra).
        const repoProfiles = buildRepoProfiles(codeTechByRepo, archetypeSignals, repoFilePaths, evidenceTopology);
        const codeStackContext = [buildCodeStackContext(codeTechByRepo), buildRepoProfileContext(repoProfiles)]
            .filter(Boolean).join('\n\n');

        // Filter-then-rank pre-filter (Increment 2): transfer-aware tech/skill + the
        // structural fork/junk gates over the chunk metadata stamp. Env-gated so it
        // ships dark; absent ⇒ today's pure-vector retrieval (fail-open).
        const retrievalPrefilter = await buildQueryRetrievalPrefilter(pool, jdExtraction, techGroups, aliasToCanonical);

        const research = await executeResearchAgent(ctx, pool, candidateGroundingBlock, educationBlock, jdExtraction, careerEntries, roleEvidenceBlock, techTransferContext, codeStackContext, retrievalPrefilter, certificationsBlock);

        // Years-gap — honest relevant-years vs the JD bar + a non-apologetic framing line.
        // Computed BEFORE the guard chain so it can deterministically constrain the matcher's
        // own overallFitRating/gaps (see applyYearsGapReconcile). Fail-open.
        const hardYearsBar = jdExtraction.hardRequirements.some((r) => r.disqualifying === true && /year/i.test(r.context));
        const yearsGap = await buildYearsGap(
            (careerEntries ?? []).map((c) => ({ title: c.title, company: c.company, period: c.period, family: null, roleClass: null })),
            jdExtraction.experienceSignals.yearsExpected,
            hardYearsBar,
            new Date().getFullYear(),
        ).catch(() => null);

        // Vendor-provenance guard (deterministic): a competing vendor evidenced ONLY by
        // reference/example docs (e.g. an "OpenAI example" in a structured-output checklist
        // while the real stack is Bedrock/Anthropic) was VERIFIED by the LLM → demote to a
        // transferable partialMatch so it is never written as first-person production work.
        // Runs BEFORE the ledger + strategist so the correction propagates to both.
        const { matching: vendorGuarded, demotions } = demoteMisattributedVendors(research.data, { techGroups, techAliasMap, codeTechByRepo });
        if (demotions.length > 0) {
            log.warn({
                pipelineRunId: env.pipelineRunId,
                demoted: demotions.map((d) => ({ skill: d.skill, vendor: d.matchedVendor, files: d.evidenceFiles })),
            }, 'vendor_provenance_demoted_reference_only_competing_vendor');
        }

        // Doc-vs-code drift guard (deterministic): a documented technology superseded
        // by the repo's current code (doc names predecessor P; code lacks P but has a
        // `succeeds`-successor of P, e.g. self-hosted Kubernetes → EKS) is demoted to a
        // past-tense partialMatch so a stale doc is never presented as current work.
        const { matching: guardedMatching, contradictions } = demoteCodeContradictedMatches(vendorGuarded, { codeTechByRepo, succeedsEdges, aliasToCanonical });
        if (contradictions.length > 0) {
            log.warn({
                pipelineRunId: env.pipelineRunId,
                contradicted: contradictions.map((c) => ({ skill: c.skill, repo: c.repo, docTech: c.docTech, codeSuccessors: c.codeSuccessors })),
            }, 'code_truth_demoted_stale_documentation_claim');
        }
        // Education / degree reconciliation (deterministic): the JD degree requirement is a
        // soft requirement that the skill/tool-centric matcher never reconciled, so a relevant
        // qualification (e.g. a Higher Diploma in Computing) was silently dropped — neither
        // credited as a relevant technical field nor flagged. Answer it EXACTLY ONCE against
        // the candidate's education so a degree line is never dropped again.
        const { matching: degreeReconciled, result: degreeResult } = applyDegreeReconcile(guardedMatching, {
            hardRequirements: jdExtraction.hardRequirements,
            softRequirements: jdExtraction.softRequirements,
            education: educationEntries,
        });
        if (degreeResult) {
            log.info({
                pipelineRunId: env.pipelineRunId,
                requirement: degreeResult.requirementSkill,
                outcome: degreeResult.verified ? 'verified' : degreeResult.partial ? 'partial' : 'gap',
            }, 'education_degree_reconciled');
        }

        // Years-gap enforcement (deterministic): when the JD's experience bar is a hard,
        // disqualifying requirement the candidate misses, the matcher (Haiku) may still rate
        // STRONG FIT with 0 gaps and "exceeds all hard requirements" — and a re-run of the SAME
        // JD then correctly rates REACH. Force the gap + cap the rating so the verdict (and the
        // downstream résumé structure it drives) is stable and honest run-to-run.
        const { matching: yearsReconciled, applied: yearsGapApplied } = applyYearsGapReconcile(degreeReconciled, yearsGap);
        if (yearsGapApplied) {
            log.info({
                pipelineRunId: env.pipelineRunId,
                relevantYears: yearsGap?.relevantYears,
                requiredYears: yearsGap?.requiredYears,
                cappedFitRating: yearsReconciled.overallFitRating,
            }, 'years_gap_enforced_disqualifying_experience_bar');
        }
        const guardedResearch = { ...research, data: yearsReconciled };

        // Assemble StrategistResearchResult from jdExtraction (JdSignal) + guarded matching.
        // Build the Skill Evidence Ledger deterministically here — it's a pure function of the
        // JD tool list and the matching result, so it belongs in the pipeline orchestrator, not the agent.
        // Canonical JD skill list — the single authoritative "what the JD needs",
        // derived once from the jd-extractor signal. The ledger + ATS coverage (and,
        // in the centralisation refactor, the matcher) all key off this same list so
        // their counts reconcile instead of diverging per LLM re-read.
        const ledgerTools = canonicalJdSkills(jdExtraction);
        const baseLedger = buildSkillEvidenceLedger(ledgerTools, guardedResearch.data, { techGroups, techAliasMap });

        // Attach STRUCTURED code-file evidence: the actual code files using each skill's
        // technology (technology_evidence), not cosine-nearest prose/lexical matches. A
        // soft skill (e.g. "complex technical communication") resolves to no code canonical
        // → keeps its honest career grounding. GAP entries untouched. Pure + deterministic
        // (no I/O), so it is called directly — it never reaches out and cannot block.
        const ledgerWithCode = attachCodeEvidence(baseLedger, { canonicalToFiles: canonicalToCodeFiles, aliasToCanonical });

        // Tag each row's source lane(s) — repo (standalone code) / project (a
        // documented project or its repos) / career (résumé). Deterministic +
        // fail-open: an empty lane index simply yields no sourceLanes. Career
        // terms are the exact company + job-title strings from the résumé.
        const careerTerms = careerEntries.flatMap((e) => [e.company, e.title]).filter(Boolean);
        const skillEvidenceLedger = attachSourceLanes(ledgerWithCode, {
            projectNames: projectLaneIndex.projectNames,
            careerTerms,
        });

        const researchData: StrategistResearchResult = {
            ...jdExtraction,
            targetCompany: ctx.targetCompany,
            ...guardedResearch.data,
            skillEvidenceLedger,
        };

        // Evidence provenance + per-repo quality + repo profiles (observability, fail-open).
        await recordRunProvenance({
            pool, env, researchData, matching: guardedMatching,
            demotions, contradictions, codeTechByRepo, repoProfiles,
        });

        await updatePipelineRun(pool, env.pipelineRunId, 'analysing');

        const analysis = await executeStrategistAgent(ctx, researchData, candidateGroundingBlock, educationBlock, experienceFactsBlock, roleEvidenceBlock, yearsGap, codeStackContext, achievementEvidenceBlock);

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
                }, { pool, userId: env.userId });
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

        // Raw tailored resume from the Strategist (guard reads this as input).
        const tailoredResumeData = analysis.data.tailoredResumeData ?? null;
        const archetype = analysis.data.archetypeSelection?.selectedArchetype ?? null;

        // ── Cover-letter guard (rule-based, fail-open, rewrite-on-violation) ──
        // Validates the AI-authored cover letter against code-enforced rules
        // (e.g. leadIdentity coherence, years-gap framing). Violations are
        // rewritten in-place and counted for observability — never throws.
        const { letter: finalCoverLetter, violations: coverViolations } = await guardCoverLetter(
            analysis.data.coverLetter,
            researchData.targetRole,
            analysis.data.archetypeSelection?.leadIdentity ?? '',
            yearsGap?.framingLine ?? '',
        );
        for (const v of coverViolations) coverLetterViolations.inc({ code: v.code });

        // ── Resume guard — F-pattern content checks (fail-open, rewrite-on-violation) ──
        // Validates the AI-authored resume against code-enforced rules (headline
        // positioning, summary cluster, education accuracy, skills lead). Violations
        // are rewritten in-place by Haiku and counted for observability — never throws.
        const archetypeId = analysis.data.archetypeSelection?.archetypeId ?? 0;
        const archetypeSkillLead = archetypeId === 7 ? 'Support & Troubleshooting' : '';
        let finalResume = tailoredResumeData;
        if (tailoredResumeData) {
            const guarded = await guardResume(tailoredResumeData, {
                targetRole:        researchData.targetRole,
                leadIdentity:      analysis.data.archetypeSelection?.leadIdentity ?? '',
                verifiedEducation: (educationEntries ?? []).map((e) => e.degree),
                archetypeSkillLead,
            });
            finalResume = guarded.resume;
            for (const v of guarded.violations) resumeViolationsMetric.inc({ code: v.code });
        }

        // JD-priority context for length enforcement — required skills + the
        // company problem decide what survives a condense (JD-relevant first).
        const jdPriority = {
            requiredSkills:   jdExtraction.requiredSkills,
            companyProblem:   jdExtraction.companyProblem,
            responsibilities: jdExtraction.responsibilities,
        };

        // Career/bullet drift: reframe an experience bullet describing a tech the code
        // has since superseded (e.g. self-hosted kubeadm → managed EKS) into an honest
        // migration narrative. Deterministic detection + grounded Haiku reframe; fail-open.
        if (finalResume) {
            const staleMigrations = detectStaleMigrations(finalResume, { succeedsEdges, codeTechByRepo, aliasToCanonical });
            if (staleMigrations.length > 0) {
                log.warn({
                    pipelineRunId: env.pipelineRunId,
                    migrations: staleMigrations.map((m) => ({ predecessor: m.predecessor, successors: m.successors })),
                }, 'migration_reframe_fired');
                const preReframe = finalResume;
                finalResume = await reframeStaleMigrations(preReframe, staleMigrations).catch(() => preReframe);
            }
            // ── Length budget (measure → condense → hard trim; fail-open) ──
            // The 2026-07-02 Google run shipped 1,723 words / 4 pages: the
            // strategist emitted 1,045 and the guard + keyword rewrites added
            // the rest. Enforce here (before persist/ATS) and again after the
            // keyword-surfacing rewrite — the last stage that can grow it.
            const preBudget = finalResume;
            finalResume = await applyLengthBudget(preBudget, jdPriority, (v) => resumeViolationsMetric.inc({ code: v.code })).catch(() => preBudget);
        }

        // Resume-builder persist (Option A): persist the guarded resume to PG.
        const persisted = finalResume
            ? await persistTailoredResume(pool, {
                applicationId:  env.applicationId,
                userId:         env.userId,
                pipelineId:     env.pipelineId,
                targetRole:     env.targetRole,
                archetype,
                tailoredResume: finalResume,
              })
            : null;

        // ── ATS render + parse-back QA (fail-open pipeline, fail-closed claim) ─
        // Renders the AI-authored resume to a text-selectable PDF, proves it
        // parses, and stores the canonical PDF + check. Delegated to a helper
        // that never throws (errors → 'unverified', never 'passed').
        let finalAts: AtsCheckResult | null = null;
        if (persisted && finalResume) {
            // Build a shared embedder for 3-tier ATS keyword matching (Titan, fail-open).
            const atsEmbedder = TitanEmbeddingProvider.fromEnvironment();
            const atsArgs = {
                s3, pool,
                bucket:        process.env['ASSETS_BUCKET'] ?? '',
                resumeId:      persisted.resumeId,
                userId:        env.userId,
                research:      researchData,
                log,
                correlationId: env.pipelineRunId,
                onOutcome:     (status: AtsCheckResult['status'] | 'error') => strategistRuns.inc({ operation: 'analyse', outcome: `ats_${status}` }),
                jdExtraction,
                familyVocab,
                embedder:      atsEmbedder,
                techGroups,
                techAliasMap,
            };
            const atsCheck = await renderCheckAndStoreAts({ ...atsArgs, resume: finalResume });
            finalAts = atsCheck;

            // ── ATS feedback loop (pass-by-generation, ONE bounded honest re-write) ──
            // Surface attainable-but-missing keywords (verified/transferable the
            // candidate genuinely has — GAPs are excluded by splitAttainable and
            // can never be surfaced) using ONLY the provided evidence, then re-render
            // + re-check ONCE. Fail-open at every await; never throws.
            const split = splitAttainable(atsCheck.jdKeywordCoverage, skillEvidenceLedger);
            if (split.attainableMissing.length > 0) {
                atsFeedback.inc({ outcome: 'fired' });
                const baseResume = finalResume; // non-null inside this guard; narrows fail-open return
                // Red flags: no structured red-flag source exists in this scope today
                // (StrategistResearchResult has no `redFlags`, no recruiter snapshot here) → [].
                const redFlags: string[] = [];
                // Grounding facts = verbatim career facts + project evidence + verified-match citations.
                const groundingFacts = [
                    experienceFactsBlock,
                    projectEvidenceBlock,
                    researchData.verifiedMatches.map((m) => `${m.skill}: ${m.sourceCitation}`).join('\n'),
                ].filter(Boolean).join('\n\n');
                // Allowed numbers = original resume + grounding facts. Any number the
                // rewrite introduces outside this set is stripped deterministically.
                const allowed = extractNumbers([JSON.stringify(baseResume), groundingFacts].join(' '));
                const refined = await surfaceKeywords(baseResume, split.attainableMissing, { redFlags, groundingFacts }).catch(() => baseResume);
                let surfaced = refined !== baseResume ? stripUngroundedNumbers(refined, allowed) : baseResume;
                if (surfaced !== baseResume) {
                    // The keyword rewrite is the last stage that can GROW the
                    // resume (it inflated the 2026-07-02 Google run by pulling
                    // grounding-facts prose into projects) — re-enforce the
                    // length budget before persisting and re-checking.
                    surfaced = await applyLengthBudget(surfaced, jdPriority, (v) => resumeViolationsMetric.inc({ code: v.code })).catch(() => surfaced);
                    finalResume = surfaced;
                    const rePersisted = await persistTailoredResume(pool, {
                        applicationId:  env.applicationId,
                        userId:         env.userId,
                        pipelineId:     env.pipelineId,
                        targetRole:     env.targetRole,
                        archetype,
                        tailoredResume: surfaced,
                    }).catch(() => null);
                    const reResumeId = rePersisted?.resumeId ?? persisted.resumeId;
                    // Re-check the SURFACED resume. A silent fallback to the
                    // pre-rewrite verdict shipped stale "missing keyword" issues
                    // for a resume that had already fixed them — so retry once,
                    // and if the re-check still fails, mark the verdict stale
                    // instead of presenting it as current.
                    finalAts = await renderCheckAndStoreAts({ ...atsArgs, resumeId: reResumeId, resume: surfaced })
                        .catch(async () => {
                            log.warn({ pipelineRunId: env.pipelineRunId }, 'ats_recheck_failed — retrying once');
                            return renderCheckAndStoreAts({ ...atsArgs, resumeId: reResumeId, resume: surfaced });
                        })
                        .catch(() => {
                            log.warn({ pipelineRunId: env.pipelineRunId }, 'ats_recheck_failed_twice — stamping stale verdict');
                            strategistRuns.inc({ operation: 'analyse', outcome: 'ats_recheck_stale' });
                            return { ...atsCheck, staleForFinalResume: true };
                        });
                }
            } else {
                atsFeedback.inc({ outcome: 'skipped' });
            }

            // Stamp the pass-mark from the FINAL coverage.
            const finalSplit = splitAttainable(finalAts.jdKeywordCoverage, skillEvidenceLedger);
            if (finalSplit.attainablePassed) atsFeedback.inc({ outcome: 'passed' });
            finalAts = {
                ...finalAts,
                attainableTotal:   finalSplit.attainableTotal,
                attainableCovered: finalSplit.attainableCovered,
                attainablePassed:  finalSplit.attainablePassed,
                surfacedKeywords:  split.attainableMissing.map((e) => e.tool),
            };
        }

        // ── Resume prose-quality (stop-slop, flag mode, fail-open) ─────────
        // Lint the generated resume + cover-letter prose for AI-tell language.
        // Pure observability — never alters the persisted resume, never throws.
        await lintResumeProse(pool, env, finalResume, finalCoverLetter);

        // ── Path-grounding check (advisory, fail-open) ────────────────────
        // Flag file-path citations in the final analysis that don't exist in
        // the user's ingested document_embeddings. Runs on finalAnalysis so it
        // reflects whatever text will actually be persisted/served.
        const pathGrounding = await verifyAnalysisPaths(
            pool, env.userId, finalAnalysis, env.pipelineRunId,
        );

        // ── Gap-cause classification (advisory, fail-open) ────────────────
        // Split every research gap into kb_present_not_retrieved (evidence
        // exists, retrieval missed it → retrieval bug lead) vs kb_no_evidence
        // (nothing in the KB → user-facing "document this" signal). Persisted
        // on the gap entries; aggregated as a Prometheus counter for Grafana.
        const gapsWithCauses = await annotateGapCauses(
            pool, env.userId, researchData.gaps, (cause) => gapCauseMetric.inc({ cause }),
        ).catch(() => researchData.gaps);

        // Stash both outputs on pipeline_runs.metadata so the admin-api detail
        // endpoint can serve research fields (fitSummary, matches, gaps, etc.)
        // and a downstream coach K8s Job can re-hydrate without re-running.
        // analysisXml is replaced by finalAnalysis (grounded or original on fail-open).
        // pathGrounding.ungrounded lets the UI warn on hallucinated source paths.
        // atsCheck is stashed here as well as on resumes.ats_check_json so the
        // value is never lost if the RLS-scoped resumes write fails — admin-api
        // falls back to metadata.analysis.atsCheck.
        await updatePipelineRunMetadata(pool, env.pipelineRunId, {
            analysis:     { ...analysis.data, tailoredResumeData: finalResume, coverLetter: finalCoverLetter, analysisXml: finalAnalysis, pathGrounding, atsCheck: finalAts, yearsGap },
            research:     { ...researchData, gaps: gapsWithCauses },
            jdExtraction,
            // LLM-agent cost (extraction + research + analysis + grounding); excludes embeddings/rerank.
            tokens:  ctx.cumulativeTokens,
            costUsd: ctx.cumulativeCostUsd,
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
                    analysis: { ...analysis.data, analysisXml: finalAnalysis },
                    research: researchData,
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
        // error_message surfaces to the client via GET /runs/:id, so redact infra
        // identifiers (hosts/ARNs/file paths/etc.) before persisting — a raw DB /
        // AWS SDK / Zod message would leak internals (security). The FULL detail is
        // kept in the structured log below (operator-only) and referenced by the
        // SNS failure alert via pipelineRunId.
        const clientMessage = outputSanitiser.sanitise(message).slice(0, 500);
        await updatePipelineRun(pool, env.pipelineRunId, 'failed', clientMessage)
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
    // Exit EXPLICITLY on success too. main() finishes its work and closes the pg
    // pool, but module-scope handles (S3Client, PgSemanticCache, fire-and-forget
    // promises) keep the event loop alive, so the process would otherwise hang —
    // leaving the K8s Job Running 0/1 until activeDeadlineSeconds force-kills it
    // (~30min) and burning a node slice every run. process.exit(0) ends it cleanly.
    main().then(
        () => process.exit(0),
        () => process.exit(1),
    );
}
