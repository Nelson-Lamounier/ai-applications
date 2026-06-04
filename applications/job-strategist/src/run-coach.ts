/**
 * @format
 * Coach K8s Job entrypoint — generates stage-specific interview coaching
 * for an existing job application.
 *
 * Status transitions on pipeline_runs (type='coach'):
 *   queued → coaching → complete (or failed)
 *
 * Inputs:
 *   - COACH_PIPELINE_RUN_ID — this run's id (UPDATE target)
 *   - STRATEGIST_PIPELINE_RUN_ID — source of analysis JSON (loaded from metadata)
 *   - INTERVIEW_STAGE + APPLICATION_ID/SLUG + TARGET_* + JOB_DESCRIPTION
 *
 * Output: a row in coaching_content (job_application_id, stage_type) upserted.
 */
import type { Pool } from 'pg';
import type {
    StrategistPipelineContext, StrategistAnalysisResult, StrategistResearchResult,
    SkillCandidateSet, InterviewStage, InterviewCoachResult,
} from '@bedrock/shared';
import {
    bootstrapK8sObservability, pushFinalMetrics,
    RdsStagePrepOntologyRepository, toRoleFamily, toCompSeniority,
    loadStagePrepConstraints, buildStagePrepConstraintBlock,
    RdsProjectEvidenceRepository, joinSkillCandidates,
    BedrockGroundingVerifier,
    BedrockProseLinter,
} from '@bedrock/shared';
import { Counter, Histogram } from 'prom-client';

import { executeCoachAgent, buildSkillCandidateBlock } from './agents/coach-agent.js';
import { stageUsesSkillTransfer } from './prompts/coach/stages/index.js';
import { buildCoachContextChunks, extractCoachClaims } from './lib/coach-grounding.js';
import { extractProseSections } from './lib/coach-prose.js';
import { parseCoachEnv }       from './env-coach.js';
import { getPool, closePool }  from './lib/pg.js';
import {
    updatePipelineRun,
    persistCoachingContent,
} from './lib/pipeline-runs.js';

async function loadAnalysisAndResearch(
    pool: Pool,
    strategistPipelineRunId: string,
): Promise<{ analysis: StrategistAnalysisResult; research: StrategistResearchResult | null }> {
    const result = await pool.query<{
        metadata: { analysis?: StrategistAnalysisResult; research?: StrategistResearchResult } | null;
    }>(
        `SELECT metadata FROM pipeline_runs WHERE id = $1`,
        [strategistPipelineRunId],
    );
    const analysis = result.rows[0]?.metadata?.analysis;
    if (!analysis) {
        throw new Error(`No analysis found in pipeline_runs.metadata for id=${strategistPipelineRunId}`);
    }
    return { analysis, research: result.rows[0]?.metadata?.research ?? null };
}

// Same registry shape as run-pipeline.ts so dashboards can SUM across
// operations on `job_strategist_runs_total{operation=~"analyse|coach"}`.
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

// Coach grounding verdicts (text-level). status ∈ GROUNDED|NOT_GROUNDED|error|skipped.
const coachGrounding = new Counter({
    name:       'job_strategist_coach_grounding_total',
    help:       'Coach output grounding verdicts by stage and status.',
    labelNames: ['stage', 'status'] as const,
    registers:  [obs.registry],
});

// Coach grounding runs in 'flag' mode only: coach output is structured JSON, so
// block-mode fallback substitution (a one-line string) would corrupt it. Flag
// records an ungrounded verdict via telemetry without altering what is persisted.
const coachGroundingVerifier = new BedrockGroundingVerifier({ mode: 'flag' });

// Coach prose-quality verdicts (stop-slop). status ∈ PASS|FAIL|error|skipped.
const coachProse = new Counter({
    name:       'job_strategist_coach_prose_total',
    help:       'Coach output prose-quality verdicts by stage and status.',
    labelNames: ['stage', 'status'] as const,
    registers:  [obs.registry],
});

// Prose linting runs in 'flag' mode only: telemetry on AI-tell language, never
// alters persisted coach output, never throws into the pipeline.
const coachProseLinter = new BedrockProseLinter({ mode: 'flag' });

/**
 * Verify the coach's experiential claims against its grounding sources and record
 * the verdict (metric + log). Flag-mode + fail-open: this is pure observability —
 * it never alters persisted output and never throws into the pipeline.
 */
async function verifyCoachGrounding(
    pool: Pool,
    env: ReturnType<typeof parseCoachEnv>,
    sources: Parameters<typeof buildCoachContextChunks>[0],
    coaching: Parameters<typeof extractCoachClaims>[0],
): Promise<void> {
    try {
        const contextChunks = buildCoachContextChunks(sources);
        const claims = extractCoachClaims(coaching);
        if (contextChunks.length === 0 || claims.trim().length === 0) {
            coachGrounding.inc({ stage: env.interviewStage, status: 'skipped' });
            return;
        }
        const g = await coachGroundingVerifier.verify({
            query: `${env.targetRole ?? ''} ${env.targetCompany ?? ''}`.trim(),
            contextChunks,
            answer: claims,
        }, { pool, userId: env.userId });
        coachGrounding.inc({ stage: env.interviewStage, status: g.status });
        if (g.status === 'NOT_GROUNDED') {
            log.warn({
                coachPipelineRunId: env.coachPipelineRunId,
                applicationId:      env.applicationId,
                stage:              env.interviewStage,
                reason:             g.reason,
                ungroundedClaims:   g.ungroundedClaims,
            }, 'coach_grounding_not_grounded');
        }
    } catch (e) {
        coachGrounding.inc({ stage: env.interviewStage, status: 'error' });
        log.warn({
            coachPipelineRunId: env.coachPipelineRunId,
            stage:              env.interviewStage,
            err:                (e as Error).message,
        }, 'coach_grounding_failed (non-fatal)');
    }
}

/**
 * Lint the coach's prose surfaces for AI-tell language and record the verdict
 * (metric + log). Flag-mode + fail-open: pure observability — never alters
 * persisted output and never throws into the pipeline.
 */
async function lintCoachProse(
    pool: Pool,
    env: ReturnType<typeof parseCoachEnv>,
    coaching: InterviewCoachResult,
): Promise<void> {
    try {
        const sections = extractProseSections(coaching);
        if (sections.length === 0) {
            coachProse.inc({ stage: env.interviewStage, status: 'skipped' });
            return;
        }
        const q = await coachProseLinter.lint(
            { sections, stage: env.interviewStage },
            { pool, userId: env.userId },
        );
        coachProse.inc({ stage: env.interviewStage, status: q.status });
        if (q.status === 'FAIL') {
            log.warn({
                coachPipelineRunId: env.coachPipelineRunId,
                applicationId:      env.applicationId,
                stage:              env.interviewStage,
                proseScore:         q.score,
                proseIssues:        q.issues,
            }, 'coach_prose_below_threshold');
        }
    } catch (e) {
        coachProse.inc({ stage: env.interviewStage, status: 'error' });
        log.warn({
            coachPipelineRunId: env.coachPipelineRunId,
            stage:              env.interviewStage,
            err:                (e as Error).message,
        }, 'coach_prose_lint_failed (non-fatal)');
    }
}

/**
 * Construct the StrategistPipelineContext for a coach run. Some fields are
 * placeholders since the coach path needs no resume data or S3 bucket — mirrors
 * the pattern in run-pipeline.ts.
 */
function buildCoachCtx(env: ReturnType<typeof parseCoachEnv>): StrategistPipelineContext {
    return {
        pipelineId:        env.coachPipelineRunId,
        operation:         'coach',
        applicationSlug:   env.applicationSlug,
        jobDescription:    env.jobDescription,
        targetCompany:     env.targetCompany,
        targetRole:        env.targetRole,
        resumeId:          process.env['RESUME_ID'] ?? '',
        resumeData:        null,
        interviewStage:    env.interviewStage as StrategistPipelineContext['interviewStage'],
        bucket:            process.env['S3_BUCKET'] ?? '',
        environment:       env.environment,
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
        startedAt:         new Date().toISOString(),
        userId:            env.userId,
    };
}

/** Stage-prep ontology calibration block (phone-screen + other supported stages). */
async function buildConstraintBlock(
    pool: Pool,
    env: ReturnType<typeof parseCoachEnv>,
    research: StrategistResearchResult | null,
): Promise<string> {
    const repo = new RdsStagePrepOntologyRepository(pool);
    const seniority = toCompSeniority((research?.seniority ?? '').toLowerCase());
    const constraints = await loadStagePrepConstraints(repo, {
        targetCompany: env.targetCompany,
        roleFamily:    toRoleFamily(env.targetRole),
        stage:         env.interviewStage,
        seniority,
        region:        env.region,
        compTarget:    env.compTarget,
    });
    const dsaTopics = env.interviewStage.startsWith('technical')
        ? research?.dsaTopicCalibration?.likelyTopics?.map(t => t.displayName)
        : undefined;
    return buildStagePrepConstraintBlock({ ...constraints, dsaTopics });
}

/** Verified-evidence digest from the Research result (phone-screen grounding). */
function buildEvidenceBlock(research: StrategistResearchResult | null): string | undefined {
    if (!research) return undefined;
    return [
        `Overall fit: ${research.overallFitRating ?? ''} — ${research.fitSummary ?? ''}`,
        `Experience signals: ${JSON.stringify(research.experienceSignals ?? {})}`,
        'Verified matches:',
        ...(research.verifiedMatches ?? []).map(m => `- ${m.skill} (${m.depth}) — ${m.sourceCitation}`),
    ].join('\n');
}

/**
 * Skill-transfer candidate sets for project-anchored stages (technical +
 * system-design), fail-open. joinSkillCandidates is skill-agnostic, so
 * system-design reuses the same deterministic candidate machinery.
 */
async function buildSkillCandidateSets(
    pool: Pool,
    env: ReturnType<typeof parseCoachEnv>,
    research: StrategistResearchResult | null,
): Promise<SkillCandidateSet[]> {
    if (!stageUsesSkillTransfer(env.interviewStage as InterviewStage)) return [];
    try {
        const evidence = await new RdsProjectEvidenceRepository(pool).load(env.userId);
        if (evidence.projects.length === 0) return [];
        const jdSkills = [
            ...(research?.verifiedMatches ?? []),
            ...(research?.partialMatches ?? []),
            ...(research?.gaps ?? []),
        ].map(m => m.skill).filter((s): s is string => !!s);
        return joinSkillCandidates([...new Set(jdSkills)], evidence);
    } catch (err) {
        log.warn({ err: String(err) }, 'skill-transfer.candidates.failed (non-fatal)');
        return [];
    }
}

async function main(): Promise<void> {
    const env  = parseCoachEnv();
    const pool = getPool(env.pg);
    const start = process.hrtime.bigint();
    let outcome: 'success' | 'failed' = 'failed';

    try {
        const { analysis, research } = await loadAnalysisAndResearch(pool, env.strategistPipelineRunId);

        await updatePipelineRun(pool, env.coachPipelineRunId, 'coaching');

        const ctx = buildCoachCtx(env);
        const constraintBlock = await buildConstraintBlock(pool, env, research);
        const evidenceBlock = buildEvidenceBlock(research);
        const skillCandidateSets = await buildSkillCandidateSets(pool, env, research);

        const coaching = await executeCoachAgent(ctx, analysis, constraintBlock, evidenceBlock, skillCandidateSets);

        // Text-level grounding on coach output — runs for EVERY stage. Complements
        // the deterministic citation-level guard already in executeCoachAgent
        // (validateSkillTransfer). Fail-open: never fails the run.
        await verifyCoachGrounding(pool, env, {
            analysisXml:         analysis.analysisXml,
            evidenceBlock,
            constraintBlock,
            skillCandidateBlock: buildSkillCandidateBlock(skillCandidateSets),
        }, coaching.data);

        // Prose-quality lint on coach output — flag-mode, runs for EVERY stage.
        // Fail-open: never fails the run, never alters what is persisted.
        await lintCoachProse(pool, env, coaching.data);

        await persistCoachingContent(pool, {
            applicationId: env.applicationId,
            stageType:     env.interviewStage,
            coaching:      coaching.data,
        });

        await updatePipelineRun(pool, env.coachPipelineRunId, 'complete');
        outcome = 'success';

        log.info({
            coachPipelineRunId: env.coachPipelineRunId,
            applicationId:      env.applicationId,
            stage:              env.interviewStage,
        }, 'coach_pipeline_complete');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await updatePipelineRun(pool, env.coachPipelineRunId, 'failed', message)
            .catch(() => { /* swallow — already failing */ });
        log.error({
            coachPipelineRunId: env.coachPipelineRunId,
            applicationId:      env.applicationId,
            stage:              env.interviewStage,
            err: message,
        }, 'coach_pipeline_failed');
        throw err;
    } finally {
        await closePool();
        const duration = Number(process.hrtime.bigint() - start) / 1e9;
        strategistRuns.inc({ operation: 'coach', outcome });
        strategistDuration.observe({ operation: 'coach', outcome }, duration);
        await pushFinalMetrics(obs.registry, 'job-strategist', env.coachPipelineRunId);
        await obs.shutdown();
    }
}

main().catch(() => process.exit(1));
