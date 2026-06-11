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
import type { StrategistPipelineContext, StructuredResumeData, GroundingMode } from '@bedrock/shared';
import type { Pool } from 'pg';
import { bootstrapK8sObservability, pushFinalMetrics, BedrockGroundingVerifier, BedrockProseLinter, PgSemanticCache, OutputSanitiser, recordInvocationToRds } from '@bedrock/shared';
import { Counter, Histogram } from 'prom-client';
import { extractResumeProseSections } from './lib/resume-prose.js';

import { executeResearchAgent, KB_CONTEXT_SEPARATOR, sanitiseJobDescription } from './agents/research-agent.js';
import { executeStrategistAgent } from './agents/strategist-agent.js';
import { loadProjectEvidenceBlock } from './agents/project-evidence-block.js';
import { loadEducation, formatEducation, loadCareerHistory, formatExperienceFacts } from './agents/career-history.js';
import { extractJobDescription } from './agents/jd-extractor.js';
import { parseEnv }               from './env.js';
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
import { buildRecruiterSnapshot } from './agents/recruiter-snapshot.js';

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
    coverLetter: string | null,
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
        onInvocationComplete: recordInvocationToRds(pool, 'job-strategist'),
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
        const jdForCache = ctx.jobDescription; // already sanitised once at entry
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
        const [projectEvidenceBlock, educationEntries, careerEntries, jdExtraction] = await Promise.all([
            loadProjectEvidenceBlock(pool, ctx.userId),
            loadEducation(pool, ctx.userId).catch(() => []),
            loadCareerHistory(pool, ctx.userId).catch(() => []),
            extractJobDescription(ctx.jobDescription),
        ]);
        const educationBlock      = formatEducation(educationEntries);
        const experienceFactsBlock = formatExperienceFacts(careerEntries);

        const research = await executeResearchAgent(ctx, pool, projectEvidenceBlock, educationBlock, jdExtraction, careerEntries);

        await updatePipelineRun(pool, env.pipelineRunId, 'analysing');
        const analysis = await executeStrategistAgent(ctx, research.data, projectEvidenceBlock, educationBlock, experienceFactsBlock);

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

        // ── ATS render + parse-back QA (fail-open pipeline, fail-closed claim) ─
        // Renders the AI-authored resume to a text-selectable PDF, proves it
        // parses, and stores the canonical PDF + check. Delegated to a helper
        // that never throws (errors → 'unverified', never 'passed').
        let atsCheck: AtsCheckResult | null = null;
        if (persisted && tailoredResumeData) {
            atsCheck = await renderCheckAndStoreAts({
                s3, pool,
                bucket:        process.env['ASSETS_BUCKET'] ?? '',
                resumeId:      persisted.resumeId,
                userId:        env.userId,
                resume:        tailoredResumeData,
                research:      research.data,
                log,
                correlationId: env.pipelineRunId,
                onOutcome:     status => strategistRuns.inc({ operation: 'analyse', outcome: `ats_${status}` }),
            });
        }

        // Recruiter snapshot — hybrid score + grounded missing-keywords/red-flags.
        // Fail-open (null on any error); needs the ATS keyword coverage, so it runs here.
        const recruiterSnapshot = await buildRecruiterSnapshot(ctx, research.data, atsCheck).catch(() => null);

        // ── Resume prose-quality (stop-slop, flag mode, fail-open) ─────────
        // Lint the generated resume + cover-letter prose for AI-tell language.
        // Pure observability — never alters the persisted resume, never throws.
        await lintResumeProse(pool, env, tailoredResumeData, analysis.data.coverLetter);

        // ── Path-grounding check (advisory, fail-open) ────────────────────
        // Flag file-path citations in the final analysis that don't exist in
        // the user's ingested document_embeddings. Runs on finalAnalysis so it
        // reflects whatever text will actually be persisted/served.
        const pathGrounding = await verifyAnalysisPaths(
            pool, env.userId, finalAnalysis, env.pipelineRunId,
        );

        // Stash both outputs on pipeline_runs.metadata so the admin-api detail
        // endpoint can serve research fields (fitSummary, matches, gaps, etc.)
        // and a downstream coach K8s Job can re-hydrate without re-running.
        // analysisXml is replaced by finalAnalysis (grounded or original on fail-open).
        // pathGrounding.ungrounded lets the UI warn on hallucinated source paths.
        // atsCheck is stashed here as well as on resumes.ats_check_json so the
        // value is never lost if the RLS-scoped resumes write fails — admin-api
        // falls back to metadata.analysis.atsCheck.
        await updatePipelineRunMetadata(pool, env.pipelineRunId, {
            analysis:     { ...analysis.data, analysisXml: finalAnalysis, pathGrounding, atsCheck, recruiterSnapshot },
            research:     research.data,
            jdExtraction,
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
                    research: research.data,
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
    main().catch(() => process.exit(1));
}
