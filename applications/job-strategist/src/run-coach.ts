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
    SkillCandidateSet, InterviewStage,
} from '@bedrock/shared';
import {
    bootstrapK8sObservability, pushFinalMetrics,
    setDefaultAgentInvocationSink, recordInvocationToRds,
    RdsStagePrepOntologyRepository, toRoleFamily, toCompSeniority,
    loadStagePrepConstraints, buildStagePrepConstraintBlock,
    RdsProjectEvidenceRepository, joinSkillCandidates,
    BedrockGroundingVerifier,
    BedrockProseLinter,
    OutputSanitiser,
    RdsSystemDesignConcernRepository, detectConcernEvidence, validateSystemDesignWalkthrough,
} from '@bedrock/shared';
import type {
    ConcernCoverage, SystemDesignConcern, SystemDesignWalkthroughCard,
    PrincipleCoverage, BarRaiserPrinciple,
} from '@bedrock/shared';
import { Counter, Histogram } from 'prom-client';

import { executeCoachAgent, buildSkillCandidateBlock, buildConcernWalkthroughBlock } from './agents/coach/coach-agent.js';
import { stageUsesSkillTransfer, stageUsesSystemDesignWalkthrough, stageUsesBarRaiserWalkthrough, stageUsesFinalPrep } from './prompts/coach/stages/index.js';
import { validateFinalPrep } from './lib/final-validation.js';
import {
    RdsLeadershipPrinciplesRepository, frameworkForCompany,
    type LeadershipPrinciple,
} from './lib/leadership-principles-repository.js';
import { detectPrincipleEvidence, buildBarRaiserBlock, validateBarRaiserWalkthrough } from './lib/bar-raiser-grounding.js';
import { buildCoachContextChunks, extractCoachClaims } from './lib/coach-grounding.js';
import { extractProseSections } from './lib/coach-prose.js';
import { parseCoachEnv }       from './env-coach.js';
import { getPool, closePool }  from './lib/db/pg.js';
import {
    updatePipelineRun,
    persistCoachingContent,
} from './lib/db/pipeline-runs.js';

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
/** Redacts infra identifiers from the failure message before it reaches the client. */
const outputSanitiser = new OutputSanitiser();

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
    coaching: Parameters<typeof extractProseSections>[0],
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

/** Below this max cosine, the portfolio only weakly matches the JD — flag it. */
const LOW_CONFIDENCE_COSINE = 0.25;

/**
 * Verified-evidence digest from the Research result. Score-aware: it tells the
 * Coach how well the portfolio actually matched this role so it cannot ground
 * confident coaching in weak/empty retrieval. When nothing cleared the floor we
 * instruct the Coach to coach from gaps only rather than claim "verified" work.
 */
function buildEvidenceBlock(research: StrategistResearchResult | null): string | undefined {
    if (!research) return undefined;
    const stats = research.kbRetrievalStats;
    const lines = [
        `Overall fit: ${research.overallFitRating ?? ''} — ${research.fitSummary ?? ''}`,
        `Experience signals: ${JSON.stringify(research.experienceSignals ?? {})}`,
    ];

    if (stats) {
        lines.push(
            `Retrieval confidence: ${stats.passageCount} passages above floor ${stats.floor.toFixed(2)}; ` +
            `cosine max ${stats.maxCosine.toFixed(2)}, median ${stats.medianCosine.toFixed(2)}.`,
        );
        if (stats.passageCount === 0) {
            lines.push(
                '⚠️ No portfolio evidence cleared the relevance floor for this role. Do NOT present skills as ' +
                '"verified from your work" — coach honestly from gaps and transferable foundations only.',
            );
        } else if (stats.maxCosine < LOW_CONFIDENCE_COSINE) {
            lines.push(
                '⚠️ Low retrieval relevance — the portfolio weakly matches this JD. Treat verified skills as ' +
                'directional; have the candidate confirm specifics before scripting answers.',
            );
        }
    }

    lines.push(
        'Verified matches:',
        ...(research.verifiedMatches ?? []).map(m => `- ${m.skill} (${m.depth}) — ${m.sourceCitation}`),
    );
    return lines.join('\n');
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

interface WalkthroughInputs { block: string; coverage: ConcernCoverage | null; concerns: SystemDesignConcern[]; }

/**
 * Deterministic system-design concern detection over project evidence + the curated
 * ontology, rendered into a block for the coach. Fail-open: any error → empty
 * walkthrough + generic coaching, never fails the run.
 */
async function buildSystemDesignWalkthroughInputs(
    pool: Pool,
    env: ReturnType<typeof parseCoachEnv>,
    research: StrategistResearchResult | null,
): Promise<WalkthroughInputs> {
    if (!stageUsesSystemDesignWalkthrough(env.interviewStage as InterviewStage)) {
        return { block: '', coverage: null, concerns: [] };
    }
    try {
        const [concerns, evidence] = await Promise.all([
            new RdsSystemDesignConcernRepository(pool).listConcerns(),
            new RdsProjectEvidenceRepository(pool).load(env.userId),
        ]);
        const jdText = `${env.jobDescription} ${(research?.gaps ?? []).map(g => g.skill).join(' ')}`;
        const coverage = detectConcernEvidence(concerns, evidence, jdText);
        return { block: buildConcernWalkthroughBlock(coverage, concerns), coverage, concerns };
    } catch (err) {
        log.warn({ err: String(err) }, 'system-design.walkthrough.detect.failed (non-fatal)');
        return { block: '', coverage: null, concerns: [] };
    }
}

interface BarRaiserInputs { block: string; coverage: PrincipleCoverage[] | null; principles: LeadershipPrinciple[]; }

/**
 * Deterministic leadership-principle detection over project evidence + the curated
 * ontology (framework chosen by target company), rendered into a block for the
 * coach. Mirrors buildSystemDesignWalkthroughInputs. Fail-open: any error → empty
 * walkthrough + generic coaching, never fails the run.
 */
async function buildBarRaiserInputs(
    pool: Pool,
    env: ReturnType<typeof parseCoachEnv>,
    research: StrategistResearchResult | null,
): Promise<BarRaiserInputs> {
    if (!stageUsesBarRaiserWalkthrough(env.interviewStage as InterviewStage)) {
        return { block: '', coverage: null, principles: [] };
    }
    try {
        const framework = frameworkForCompany(env.targetCompany);
        const [principles, evidence] = await Promise.all([
            new RdsLeadershipPrinciplesRepository(pool).load(framework),
            new RdsProjectEvidenceRepository(pool).load(env.userId),
        ]);
        const jdText = `${env.jobDescription} ${(research?.gaps ?? []).map(g => g.skill).join(' ')}`;
        const coverage = detectPrincipleEvidence(principles, evidence, jdText);
        return { block: buildBarRaiserBlock(coverage, principles), coverage, principles };
    } catch (err) {
        log.warn({ err: String(err) }, 'bar-raiser.walkthrough.detect.failed (non-fatal)');
        return { block: '', coverage: null, principles: [] };
    }
}

interface FinalInputs { block: string; }

/** Strength bullet lines for the final-round digest (verified + partial matches). */
function finalStrengthLines(research: StrategistResearchResult | null): string[] {
    const strengths = [
        ...(research?.verifiedMatches ?? []).map(m => `${m.skill} (${m.depth}) — ${m.sourceCitation}`),
        ...(research?.partialMatches ?? []).map(m => `${m.skill} (partial) — ${m.transferableFoundation}`),
    ];
    if (strengths.length === 0) return ['- (none surfaced — frame honestly from the analysis)'];
    return strengths.map(s => `- ${s}`);
}

/** Gap bullet lines for the final-round digest (honest, forward-looking framing). */
function finalGapLines(research: StrategistResearchResult | null): string[] {
    const gaps = (research?.gaps ?? []).map(g => `${g.skill} (${g.impactSeverity}) — ${g.disqualifyingAssessment}`);
    if (gaps.length === 0) return ['- (none material)'];
    return gaps.map(g => `- ${g}`);
}

/**
 * Career-arc + role-fit context for the final-round prep stage. Minimal — no DB
 * load beyond the coach's existing analysis/research context. Assembles a compact
 * "Career arc + role-fit" digest from the Research result (strengths via verified/
 * partial matches, gaps) plus the JD/company fields already on `env`. Fail-open:
 * any error → empty block + generic final-round coaching, never fails the run.
 */
function buildFinalInputs(
    env: ReturnType<typeof parseCoachEnv>,
    research: StrategistResearchResult | null,
): FinalInputs {
    if (!stageUsesFinalPrep(env.interviewStage as InterviewStage)) return { block: '' };
    try {
        const lines = [
            '## Career arc + role-fit context (ground the final-round prep in THIS evidence)',
            `Target role: ${env.targetRole}`,
            `Target company: ${env.targetCompany}`,
            `Overall fit: ${research?.overallFitRating ?? ''} — ${research?.fitSummary ?? ''}`,
            'Strengths to anchor "why this role" and mutual-fit talking points:',
            ...finalStrengthLines(research),
            'Gaps to address with honest, forward-looking framing (never overclaim):',
            ...finalGapLines(research),
        ];
        return { block: lines.join('\n') };
    } catch (err) {
        log.warn({ err: String(err) }, 'final.prep.inputs.failed (non-fatal)');
        return { block: '' };
    }
}

async function main(): Promise<void> {
    const env  = parseCoachEnv();
    const pool = getPool(env.pg);
    // Process-wide invocation sink: coach helper agents build local contexts
    // without onInvocationComplete — register once so every Bedrock call in
    // this Job records to prompt_invocations with user attribution.
    setDefaultAgentInvocationSink(
        recordInvocationToRds(pool, 'job-strategist', {}),
        env.userId,
    );
    const start = process.hrtime.bigint();
    let outcome: 'success' | 'failed' = 'failed';

    // Disruption guard: on SIGTERM (Karpenter eviction / node drain) or SIGINT the
    // process dies WITHOUT hitting the catch below, leaving the run stuck at
    // 'coaching' — so the UI spins forever. Mark it 'failed' first; K8s grants a
    // termination grace period and this UPDATE is sub-second. (The reconciler sweep
    // is the slower backstop if even this is skipped.)
    const onSignal = (sig: NodeJS.Signals): void => {
        log.warn({ coachPipelineRunId: env.coachPipelineRunId, sig }, 'coach_interrupted');
        void updatePipelineRun(pool, env.coachPipelineRunId, 'failed', `Interrupted by ${sig} before completion`)
            .catch(() => { /* best-effort — already terminating */ })
            .finally(() => process.exit(1));
    };
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT',  () => onSignal('SIGINT'));

    try {
        const { analysis, research } = await loadAnalysisAndResearch(pool, env.strategistPipelineRunId);

        await updatePipelineRun(pool, env.coachPipelineRunId, 'coaching');

        const ctx = buildCoachCtx(env);
        const constraintBlock = await buildConstraintBlock(pool, env, research);
        const evidenceBlock = buildEvidenceBlock(research);
        const skillCandidateSets = await buildSkillCandidateSets(pool, env, research);
        const sd = await buildSystemDesignWalkthroughInputs(pool, env, research);
        const br = await buildBarRaiserInputs(pool, env, research);
        const fin = buildFinalInputs(env, research);

        const coaching = await executeCoachAgent(ctx, analysis, {
            constraintBlock,
            evidenceBlock,
            skillCandidateSets,
            systemDesignBlock: sd.block,
            barRaiserBlock:    br.block,
            finalBlock:        fin.block,
            verifiedSkills:    (research?.verifiedMatches ?? []).map(m => m.skill),
        });
        if (sd.coverage) {
            const raw = (coaching.data.systemDesignWalkthrough ?? []) as SystemDesignWalkthroughCard[];
            (coaching.data as { systemDesignWalkthrough?: unknown }).systemDesignWalkthrough =
                validateSystemDesignWalkthrough(raw, sd.coverage);
            (coaching.data as { systemDesignCoverage?: unknown }).systemDesignCoverage = sd.coverage;
        }
        if (br.coverage) {
            const raw = (coaching.data.barRaiserWalkthrough ?? []) as BarRaiserPrinciple[];
            (coaching.data as { barRaiserWalkthrough?: unknown }).barRaiserWalkthrough =
                validateBarRaiserWalkthrough(raw, br.coverage);
            // Code-authoritative coverage counts (mirrors ConcernCoverage relevantTotal/
            // relevantAddressed): relevant principles, and those with any grounded evidence.
            const relevant = br.coverage.filter(d => d.relevantToJd);
            (coaching.data as { barRaiserCoverage?: unknown }).barRaiserCoverage = {
                detected:          br.coverage,
                relevantTotal:     relevant.length,
                relevantAddressed: relevant.filter(d => d.coverage !== 'none').length,
            };
        }
        if (stageUsesFinalPrep(env.interviewStage as InterviewStage)) {
            (coaching.data as { finalPrep?: unknown }).finalPrep = validateFinalPrep(coaching.data.finalPrep);
        }

        // Text-level grounding on coach output — runs for EVERY stage. Complements
        // the deterministic citation-level guard already in executeCoachAgent
        // (validateSkillTransfer). Fail-open: never fails the run.
        // Prose-quality lint on coach output — flag-mode, runs for EVERY stage.
        // Fail-open: never fails the run, never alters what is persisted.
        // Both are independent observability calls — run concurrently to halve latency.
        await Promise.all([
            verifyCoachGrounding(pool, env, {
                analysisXml:         analysis.analysisXml,
                evidenceBlock,
                constraintBlock,
                skillCandidateBlock: buildSkillCandidateBlock(skillCandidateSets),
            }, coaching.data),
            lintCoachProse(pool, env, coaching.data),
        ]);

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
        // Redact infra identifiers before persisting — error_message surfaces to the
        // client via GET /runs/:id. Full detail stays in the log below.
        const clientMessage = outputSanitiser.sanitise(message).slice(0, 500);
        await updatePipelineRun(pool, env.coachPipelineRunId, 'failed', clientMessage)
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

// Exit EXPLICITLY on success too. main() awaits its work and cleanup (closePool
// + obs.shutdown), but module-scope handles (Bedrock keep-alive sockets,
// pushgateway HTTP agent) keep the event loop alive, so the process would
// otherwise hang after success — leaving the K8s Job Running 0/1 until
// activeDeadlineSeconds force-kills it (~30min) and stamping a successful run as
// Failed. process.exit(0) ends it cleanly. Mirrors run-pipeline.ts.
main().then(
    () => process.exit(0),
    () => process.exit(1),
);
