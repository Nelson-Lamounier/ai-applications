/**
 * @format
 * Free-tier pipeline orchestrator — MODE=free entry point.
 *
 * Flat 9-step sequence:
 *   1. Extract JD signal
 *   2. Gather evidence (RAG + project + career + education)
 *   3. Write resume + cover letter (single Sonnet call)
 *   4. Guard cover letter (rule-based, rewrite-on-violation, fail-open)
 *   5. Compute grounded ATS keyword coverage (deterministic, no LLM)
 *   6. Persist resume
 *   7. Persist pipeline run metadata (resume + cover letter + ATS + JD signal)
 *   8. Mark job application as 'analysis-ready'
 *   9. Mark pipeline run as 'complete'
 *
 * All external dependencies are injected via RunFreeDeps so the unit test
 * drives the orchestrator without Bedrock or a real Postgres pool.
 */
import type { Pool } from 'pg';
import type { BasePipelineContext, JdSignal, CoverLetter } from '@bedrock/shared';
import type { StrategistEnv } from '../env.js';
import type { FreeEvidence } from './gather-evidence.js';
import type { FreeWriter, FreeResumeOutput } from '../agents/writer/free-resume-writer.js';
import type { AtsCoverage } from '../ats/grounded-coverage.js';
import type { AtsCheckResult } from '../ats/ats-check.schema.js';
import type { EvidenceFit } from '../ats/evidence-fit.js';
import { groundedAtsCoverage } from '../ats/grounded-coverage.js';
import { evidenceFitScore } from '../ats/evidence-fit.js';
import { jdAtsKeywords } from '../ats/jd-keywords-union.js';
import { guardCoverLetter } from '../agents/quality/cover-letter-guard.js';

// =============================================================================
// DEPENDENCY INJECTION INTERFACES
// =============================================================================

export interface RunFreeDeps {
    /** Extract the full JD signal from a raw job description; accrues cost on ctx. */
    extractJdSignal(jd: string, ctx: BasePipelineContext): Promise<JdSignal>;

    /** Gather RAG + project + career + education evidence for the JD. */
    gather(pool: Pool, env: StrategistEnv, jdSignal: JdSignal): Promise<FreeEvidence>;

    /** Narrative resume + cover letter writer (Bedrock Sonnet). */
    writer: FreeWriter;

    /** Load the alias-to-canonical map from the skill ontology. */
    aliasMap(pool: Pool): Promise<Map<string, string>>;

    /** Persist the tailored resume to PG; returns { resumeId } or null on schema failure. */
    persistResume(
        pool: Pool,
        args: {
            applicationId: string;
            userId:        string;
            pipelineId:    string;
            targetRole:    string;
            archetype:     string | null;
            tailoredResume: unknown;
        },
    ): Promise<{ resumeId: string } | null>;

    /** Stash analysis artefacts on pipeline_runs.metadata. */
    persistMeta(pool: Pool, pipelineRunId: string, metadata: Record<string, unknown>): Promise<void>;

    /** Update job_applications.kanban_status. */
    setStatus(pool: Pool, applicationId: string, kanbanStatus: string): Promise<void>;

    /** Update pipeline_runs.status. */
    complete(pool: Pool, pipelineRunId: string, status: string): Promise<void>;
}

// =============================================================================
// ATS ADAPTER
// =============================================================================

/**
 * Convert the lean deterministic AtsCoverage into the canonical AtsCheckResult
 * shape that admin-api reads from `resumes.ats_check_json ?? metadata.analysis.atsCheck`
 * and the UI AtsPanel expects (`jdKeywordCoverage: { term, present, grounded, tier }[]`).
 */
function toAtsCheck(coverage: AtsCoverage): AtsCheckResult {
    return {
        machineReadable:          false,
        standardSectionsDetected: [],
        contactDetected:          { name: '', email: '' },
        parseBreakers:            [],
        jdKeywordCoverage: [
            ...coverage.covered.map((term) => ({ term, present: true,  grounded: true,  tier: 'literal' as const })),
            ...coverage.missing.map((term) => ({ term, present: false, grounded: false, tier: 'none'    as const })),
        ],
        status: 'unverified',
        passed: false,
        issues: [],
    };
}

// =============================================================================
// EVIDENCE CORPUS HELPER
// =============================================================================

/**
 * Flatten the gathered FreeEvidence into one text blob for the deterministic
 * evidence-fit score — every source the writer may ground a claim in, so the
 * score reflects what the candidate actually has, not what the resume printed.
 */
function freeEvidenceCorpus(e: FreeEvidence): string {
    return [
        ...e.kbPassages,
        e.extractedTech,
        e.careerFacts,
        e.educationFacts,
        e.projectEvidence,
        e.commitPrEvidence,
        e.profileIntelligence,
        e.achievementEvidence,
    ].join('\n');
}

// =============================================================================
// METADATA HELPER
// =============================================================================

function buildFreeMetadata(
    resume:      FreeResumeOutput['resume'],
    coverLetter: CoverLetter | null,
    ats:         AtsCoverage,
    fit:         EvidenceFit,
    jdSignal:    JdSignal,
    ctx:         BasePipelineContext,
): Record<string, unknown> {
    return {
        analysis: {
            tailoredResumeData: resume,
            coverLetter,
            atsCheck:           toAtsCheck(ats),
            // Deterministic evidence-fit score (zero-LLM) — what the user has
            // evidence for vs the JD. Distinct from atsCheck (resume-side).
            evidenceFit:        fit,
            mode:               'free',
        },
        jdExtraction: jdSignal,
        // LLM-agent cost (extraction + writer); excludes embeddings/rerank.
        tokens:  ctx.cumulativeTokens,
        costUsd: ctx.cumulativeCostUsd,
    };
}

// =============================================================================
// ORCHESTRATOR
// =============================================================================

/**
 * Run the free-tier pipeline to completion.
 *
 * Never throws — callers should wrap in a try/catch and handle failures via
 * the existing updatePipelineRun('failed') path in run-pipeline.ts main().
 */
export async function runFreeTier(
    pool: Pool,
    env:  StrategistEnv,
    deps: RunFreeDeps,
): Promise<void> {
    // Shared cost accumulator — threaded through all LLM calls so metadata
    // captures the full per-run cost (extraction + writer).
    const ctx: BasePipelineContext = {
        pipelineId:        env.pipelineId,
        environment:       env.environment ?? 'production',
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
    };

    // 1. Extract JD signal (cost accrues on ctx)
    const jdSignal = await deps.extractJdSignal(env.jobDescription, ctx);

    // 2. Gather evidence
    const evidence = await deps.gather(pool, env, jdSignal);

    // 3. Write resume + cover letter (single Sonnet call; cost accrues on ctx)
    const { resume, coverLetter } = await deps.writer.invoke(
        { jdSignal, evidence, targetRole: env.targetRole, targetCompany: env.targetCompany },
        ctx,
    );

    // 4. Guard cover letter (validate → rewrite-on-violation, fail-open)
    const { letter: guardedLetter } = await guardCoverLetter(
        coverLetter,
        env.targetRole,
        '',   // leadIdentity — not used in free tier
        '',   // yearsGapFraming — not computed in free tier
    );

    // 5. Grounded ATS keyword coverage (resume-side) + evidence-fit score
    //    (candidate-side). Both deterministic, no LLM — they reuse the same
    //    alias map, so the fit score adds zero marginal cost.
    const jdKeywords = jdAtsKeywords(jdSignal);
    const aliasToCanonical = await deps.aliasMap(pool);
    const ats = groundedAtsCoverage(JSON.stringify(resume), jdKeywords, aliasToCanonical);
    const fit = evidenceFitScore(jdSignal, freeEvidenceCorpus(evidence), aliasToCanonical);

    // 6. Persist resume
    await deps.persistResume(pool, {
        applicationId:  env.applicationId,
        userId:         env.userId,
        pipelineId:     env.pipelineId,
        targetRole:     env.targetRole,
        archetype:      null,
        tailoredResume: resume,
    });

    // 7. Persist pipeline run metadata (includes LLM-agent cost from ctx)
    await deps.persistMeta(
        pool,
        env.pipelineRunId,
        buildFreeMetadata(resume, guardedLetter, ats, fit, jdSignal, ctx),
    );

    // 8. Mark job application as 'analysis-ready'
    await deps.setStatus(pool, env.applicationId, 'analysis-ready');

    // 9. Mark pipeline run as 'complete'
    await deps.complete(pool, env.pipelineRunId, 'complete');
}
