/**
 * @format
 * Article pipeline K8s Job entrypoint — replaces the Trigger/Research/Writer/QA
 * Lambda chain orchestrated by Step Functions.
 *
 * Status transitions persisted in platform RDS pipeline_runs:
 *   queued → researching → writing → qa → complete (or failed at any step)
 *
 * On QA pass the rendered draft is persisted to platform RDS articles.status =
 * 'review'. The admin-api owns the eventual transition to 'published'.
 */
import type { PipelineContext, QaValidationResult, ProseQualityResult } from '@bedrock/shared';
import { bootstrapK8sObservability, pushFinalMetrics, PiiScrubber, BedrockGroundingVerifier, BedrockProseLinter, emitEmfMetric, recordInvocationToRds } from '@bedrock/shared';
import type { Pool } from 'pg';
import { Counter, Histogram } from 'prom-client';

import { executeResearchAgent } from './agents/research-agent.js';
import { executeWriterAgent }   from './agents/writer-agent.js';
import { executeQaAgent, QA_PASS_THRESHOLD } from './agents/qa-agent.js';
import { lintArticle, checkLinkLiveness, type Finding } from './lint/article-lint-rules.js';
import { hasDisclosureBlocker } from './lint/disclosure-gate.js';
import { reconcileFrontmatter, computeReadingTime, stripProseEmDashes } from './lint/frontmatter-reconcile.js';
import {
    resolveMaxRetries,
    qaPassed,
    recordAttempt,
    buildRevisionNotes,
    articleStatusFor,
    type QaAttempt,
    type QaGateResult,
} from './qa-gate.js';
import { BedrockEvidenceAdjudicator, type EvidenceAdjudicationResult } from './agents/evidence-adjudicator.js';
import { selectArchetype }      from './prompts/archetypes.js';
import { parseEnv }             from './env.js';
import { getPool, closePool }   from './lib/pg.js';
import {
    updatePipelineRun,
    updatePipelineRunMetadata,
    persistArticle,
} from './lib/pipeline-runs.js';

const piiScrubber = new PiiScrubber();
const groundingVerifier = new BedrockGroundingVerifier({ mode: 'flag' });
// stop-slop prose critic (flag mode): scores the article body for AI-tell
// language, never mutates content, fails open.
const proseLinter = new BedrockProseLinter({ mode: 'flag' });
// Decides the KB-dependent lint findings (enumerated generalisations, dangling
// caveats, title claims) against the retrieved KB. Fail-safe: DEFECT on doubt.
const evidenceAdjudicator = new BedrockEvidenceAdjudicator();
const obs = bootstrapK8sObservability({ serviceName: 'article-pipeline' });
const log = obs.logger;

const pipelineRuns = new Counter({
    name:       'article_pipeline_runs_total',
    help:       'Article pipeline Job runs by terminal outcome.',
    labelNames: ['outcome'] as const,
    registers:  [obs.registry],
});
const pipelineDuration = new Histogram({
    name:       'article_pipeline_duration_seconds',
    help:       'End-to-end pipeline duration in seconds.',
    labelNames: ['outcome'] as const,
    buckets:    [10, 30, 60, 120, 300, 600, 1200, 1800],
    registers:  [obs.registry],
});
const stepDuration = new Histogram({
    name:       'article_pipeline_step_duration_seconds',
    help:       'Per-stage duration (research / writing / qa).',
    labelNames: ['step'] as const,
    buckets:    [1, 5, 15, 30, 60, 120, 300, 600],
    registers:  [obs.registry],
});

async function timed<T>(step: string, fn: () => Promise<T>): Promise<T> {
    const t0 = process.hrtime.bigint();
    try { return await fn(); }
    finally {
        stepDuration.observe({ step }, Number(process.hrtime.bigint() - t0) / 1e9);
    }
}

/**
 * Build the pipeline_runs.metadata payload from the QA verdict (+ grounding).
 * QA issues live per-dimension; flatten them (tagged with their dimension) into
 * one reviewable list so the admin review UI can show WHY an article needs
 * revision, not just a score.
 */
function buildRunMetadata(
    qa: QaValidationResult,
    gate: QaGateResult,
    groundingMeta: object | undefined,
    lintMeta: object | undefined,
    proseMeta: object | undefined,
    evidenceMeta: object | undefined,
): Record<string, unknown> {
    const issues = Object.entries(qa.dimensions).flatMap(([dimension, dim]) =>
        dim.issues.map((issue) => ({ dimension, ...issue })),
    );
    const meta: Record<string, unknown> = {
        qa: {
            overallScore:       qa.overallScore,
            recommendation:     qa.recommendation,
            confidenceOverride: qa.confidenceOverride,
            summary:            qa.summary,
            dimensionScores:    Object.fromEntries(
                Object.entries(qa.dimensions).map(([k, v]) => [k, v.score]),
            ),
            issues,
        },
        // Full gate history: every attempt's score, verdict, failed dimensions
        // and issues, plus whether the article ultimately passed or was flagged.
        // This is the queryable record for iterating the Writer prompt / QA design
        // (pipeline_runs.metadata->'qaGate').
        qaGate: gate,
    };
    if (groundingMeta !== undefined) {
        meta['grounding'] = groundingMeta;
    }
    if (lintMeta !== undefined) {
        meta['lint'] = lintMeta;
    }
    if (proseMeta !== undefined) {
        meta['prose'] = proseMeta;
    }
    if (evidenceMeta !== undefined) {
        meta['evidence'] = evidenceMeta;
    }
    return meta;
}

/**
 * Prose-quality (stop-slop) lint of the article body — flag mode, fail-open.
 * Scores the scrubbed content for AI-tell language; never blocks the run and
 * never mutates content. Returns the verdict slice for pipeline_runs.metadata.
 */
async function lintArticleProse(
    pool: Pool,
    env: ReturnType<typeof parseEnv>,
    scrubbedContent: string,
): Promise<Pick<ProseQualityResult, 'status' | 'score' | 'belowThreshold' | 'issues'> | undefined> {
    try {
        const p = await proseLinter.lint({
            sections: [{ location: 'article.content', register: 'narrative', text: scrubbedContent }],
            stage:    'review',
        }, env.userId ? { pool, userId: env.userId } : undefined);
        if (p.status === 'FAIL') {
            log.warn({
                pipelineRunId: env.pipelineRunId,
                slug:          env.slug,
                proseScore:    p.score,
                proseIssues:   p.issues,
            }, 'article_prose_below_threshold');
        }
        return { status: p.status, score: p.score, belowThreshold: p.belowThreshold, issues: [...p.issues] };
    } catch (e) {
        log.warn({
            pipelineRunId: env.pipelineRunId,
            slug:          env.slug,
            error:         (e as Error).message,
        }, 'Prose linter failed — proceeding');
        return undefined;
    }
}

type ResearchData = Awaited<ReturnType<typeof executeResearchAgent>>['data'];

/**
 * Grounding check (flag mode), extracted from main() to keep its cyclomatic
 * complexity in budget. Always-on, never blocks persist; fail-open — any
 * verifier error is logged and swallowed so the article still reaches 'review'.
 */
async function verifyArticleGrounding(
    pool: Pool,
    env: ReturnType<typeof parseEnv>,
    researchData: ResearchData,
    scrubbedContent: string,
): Promise<Pick<Awaited<ReturnType<typeof groundingVerifier.verify>>, 'status' | 'reason' | 'ungroundedClaims'> | undefined> {
    try {
        const g = await groundingVerifier.verify({
            query:        `${env.slug} ${researchData.authorDirection ?? ''}`.trim().slice(0, 500),
            contextChunks: (researchData.kbPassages ?? []).map((p) => p.text),
            answer:       scrubbedContent,
        }, env.userId ? { pool, userId: env.userId } : undefined);
        emitEmfMetric('ArticlePipeline', { Stage: 'grounding', Status: g.status }, [
            { name: 'GroundingChecked',      value: 1,                                     unit: 'Count' },
            { name: 'GroundingFailed',       value: g.status === 'NOT_GROUNDED' ? 1 : 0,  unit: 'Count' },
            { name: 'UngroundedClaimCount',  value: g.ungroundedClaims.length,             unit: 'Count' },
        ]);
        return { status: g.status, reason: g.reason, ungroundedClaims: [...g.ungroundedClaims] };
    } catch (e) {
        emitEmfMetric('ArticlePipeline', { Stage: 'grounding', Status: 'ERROR' }, [
            { name: 'GroundingError', value: 1, unit: 'Count' },
        ]);
        log.warn({
            pipelineRunId: env.pipelineRunId,
            slug:          env.slug,
            error:         (e as Error).message,
        }, 'Grounding verifier failed — proceeding');
        return undefined;
    }
}

/**
 * Read the per-article operational-identifier allowlist. Sourced from the
 * article brief when present; defaults to the dev cluster name so the
 * author's intended transparency (a dev-only cluster) does not flag.
 */
function readPublishIdentifiers(env: ReturnType<typeof parseEnv>): string[] {
    const brief = env.articleBrief as Record<string, unknown> | undefined;
    const fromBrief = brief?.['publishIdentifiers'];
    if (Array.isArray(fromBrief)) {
        return fromBrief.filter((x): x is string => typeof x === 'string');
    }
    return ['k8s-eks-development'];
}

/**
 * Deterministic structural lint (flag/record mode, fail-open). Runs the
 * mechanical checks (title-body coverage, cross-section duplication, slop
 * constructions, em-dash density, dangling references, manual TOC, link shape,
 * identifier leaks, enumerated generalisations) on the scrubbed body. Records
 * findings to pipeline_runs.metadata + EMF metrics; never blocks the run. The
 * async liveness check runs only when ARTICLE_LINK_LIVENESS=1 (network I/O).
 * Positioned before grounding so its findings can drive the verifier (Phase 2).
 */
async function lintArticleStructure(
    env: ReturnType<typeof parseEnv>,
    title: string,
    scrubbedContent: string,
): Promise<{ errors: number; warnings: number; findings: Finding[] } | undefined> {
    try {
        const fm = { title, publishIdentifiers: readPublishIdentifiers(env) };
        const findings = lintArticle(scrubbedContent, fm);
        if (process.env['ARTICLE_LINK_LIVENESS'] === '1') {
            findings.push(...await checkLinkLiveness(scrubbedContent));
        }
        const errors = findings.filter((f) => f.severity === 'error').length;
        const warnings = findings.length - errors;
        emitEmfMetric('ArticlePipeline', { Stage: 'structural-lint' }, [
            { name: 'LintChecked',  value: 1,        unit: 'Count' },
            { name: 'LintErrors',   value: errors,   unit: 'Count' },
            { name: 'LintWarnings', value: warnings, unit: 'Count' },
        ]);
        if (errors > 0) {
            log.warn({
                pipelineRunId: env.pipelineRunId,
                slug:          env.slug,
                lintErrors:    findings.filter((f) => f.severity === 'error'),
            }, 'article_structural_lint_errors');
        }
        return { errors, warnings, findings };
    } catch (e) {
        emitEmfMetric('ArticlePipeline', { Stage: 'structural-lint', Status: 'ERROR' }, [
            { name: 'LintError', value: 1, unit: 'Count' },
        ]);
        log.warn({
            pipelineRunId: env.pipelineRunId,
            slug:          env.slug,
            error:         (e as Error).message,
        }, 'Structural linter failed — proceeding');
        return undefined;
    }
}

/**
 * Evidence adjudication (flag/record mode, fail-open wrapper). Sends the
 * KB-dependent lint findings to Sonnet to decide DEFECT/CLEARED against the
 * retrieved KB. The adjudicator self-skips (no Bedrock call) when no finding
 * routes to it, so this is free for a clean draft. Records the verdicts to
 * pipeline_runs.metadata.evidence; never blocks the run.
 */
async function adjudicateArticleEvidence(
    pool: Pool,
    env: ReturnType<typeof parseEnv>,
    findings: readonly Finding[],
    researchData: ResearchData,
    scrubbedContent: string,
): Promise<Pick<EvidenceAdjudicationResult, 'verdicts' | 'defects'> | undefined> {
    try {
        const res = await evidenceAdjudicator.adjudicate({
            findings,
            contextChunks: (researchData.kbPassages ?? []).map((p) => p.text),
            draft:         scrubbedContent,
        }, env.userId ? { pool, userId: env.userId } : undefined);
        if (res.verdicts.length === 0) return undefined;
        if (res.defects > 0) {
            log.warn({
                pipelineRunId:   env.pipelineRunId,
                slug:            env.slug,
                evidenceDefects: res.verdicts.filter((v) => v.decision === 'DEFECT'),
            }, 'article_evidence_defects');
        }
        return { verdicts: res.verdicts, defects: res.defects };
    } catch (e) {
        log.warn({
            pipelineRunId: env.pipelineRunId,
            slug:          env.slug,
            error:         (e as Error).message,
        }, 'Evidence adjudicator failed — proceeding');
        return undefined;
    }
}

/**
 * Anti-fabrication gate (flag-gated). When ARTICLE_ARCHETYPE_ASSEMBLY=1 and the
 * research carried an evidence inventory, refuse to generate if no archetype
 * meets its evidence minimums — a thin-evidence topic routes to human review
 * (failed run + reason) rather than being written from general knowledge.
 * No-op when the flag is off or the inventory is absent (legacy path).
 */
function gateArchetypeEligibility(
    env: ReturnType<typeof parseEnv>,
    researchData: ResearchData,
): void {
    if (process.env['ARTICLE_ARCHETYPE_ASSEMBLY'] !== '1') return;
    const inv = researchData.evidenceInventory;
    if (!inv) return;
    const sel = selectArchetype(inv);
    if (sel.eligible) {
        emitEmfMetric('ArticlePipeline', { Stage: 'archetype', Archetype: sel.archetype.id }, [
            { name: 'ArchetypeSelected', value: 1, unit: 'Count' },
        ]);
        log.info({ pipelineRunId: env.pipelineRunId, slug: env.slug, archetype: sel.archetype.id }, 'archetype_selected');
        return;
    }
    emitEmfMetric('ArticlePipeline', { Stage: 'archetype', Status: 'INELIGIBLE' }, [
        { name: 'ArchetypeIneligible', value: 1, unit: 'Count' },
    ]);
    throw new Error(`archetype selection ineligible — ${sel.fallbackReason}`);
}

// ---------------------------------------------------------------------------
// QA gate — retry-then-flag with full attempt capture
// ---------------------------------------------------------------------------
// Decision logic (pass boundary, retry clamp, attempt capture) lives in the
// unit-tested ./qa-gate module. This section is the Bedrock-facing orchestration.

/**
 * Retry budget, hard-clamped in ./qa-gate to [0, 2]. Configurable DOWN via
 * ARTICLE_QA_MAX_RETRIES; it can never exceed 2, so at most 3 generations run
 * (1 initial + 2 retries) before the article is flagged for human review.
 */
const QA_MAX_RETRIES = resolveMaxRetries(process.env['ARTICLE_QA_MAX_RETRIES']);

/** EMF per-attempt so QA-fail rates are visible in CloudWatch without a DB read. */
function emitQaAttemptMetric(qa: QaValidationResult): void {
    emitEmfMetric('ArticlePipeline', { Stage: 'qa-attempt', Recommendation: qa.recommendation }, [
        { name: 'QaAttemptScore',  value: qa.overallScore,                       unit: 'None' },
        { name: 'QaAttemptFailed', value: qaPassed(qa, QA_PASS_THRESHOLD) ? 0 : 1, unit: 'Count' },
    ]);
}

type WriterOut = Awaited<ReturnType<typeof executeWriterAgent>>;
type QaOut     = Awaited<ReturnType<typeof executeQaAgent>>;

/** Run one Writer -> QA cycle and record the attempt. */
async function writeAndReview(
    ctx: PipelineContext,
    researchData: ResearchData,
    attemptNo: number,
    revisionNotes: readonly string[] | undefined,
    attempts: QaAttempt[],
): Promise<{ writer: WriterOut; qa: QaOut }> {
    const writer = await timed('writing', () => executeWriterAgent(ctx, researchData, revisionNotes));
    const qa = await timed('qa', () => executeQaAgent(
        ctx, writer.data, researchData.technicalFacts,
        (researchData.kbPassages ?? []).map((p) => p.text), researchData.mode,
    ));
    attempts.push(recordAttempt(attemptNo, qa.data, QA_PASS_THRESHOLD));
    emitQaAttemptMetric(qa.data);
    return { writer, qa };
}

/**
 * Generate with a bounded QA gate. Writes, reviews, and on a failing verdict
 * retries the Writer with the QA issues injected as feedback — up to
 * {@link QA_MAX_RETRIES} times. Returns the final draft plus the full gate
 * history so the caller can persist review vs flagged and record every attempt.
 */
async function generateWithQaGate(
    ctx: PipelineContext,
    env: ReturnType<typeof parseEnv>,
    researchData: ResearchData,
): Promise<{ writer: WriterOut; qa: QaOut; gate: QaGateResult }> {
    const attempts: QaAttempt[] = [];
    let { writer, qa } = await writeAndReview(ctx, researchData, 0, undefined, attempts);

    let n = 0;
    while (!qaPassed(qa.data, QA_PASS_THRESHOLD) && n < QA_MAX_RETRIES) {
        n++;
        ctx.retryAttempt = n;
        log.warn({
            pipelineRunId:  env.pipelineRunId,
            slug:           env.slug,
            attempt:        n,
            prevScore:      qa.data.overallScore,
            recommendation: qa.data.recommendation,
        }, 'article_qa_retry');
        ({ writer, qa } = await writeAndReview(ctx, researchData, n, buildRevisionNotes(qa.data), attempts));
    }

    const passed = qaPassed(qa.data, QA_PASS_THRESHOLD);
    emitEmfMetric('ArticlePipeline', { Stage: 'qa-gate', Outcome: passed ? 'PASSED' : 'FLAGGED' }, [
        { name: 'QaGateAttempts', value: attempts.length,  unit: 'Count' },
        { name: 'QaGateFlagged',  value: passed ? 0 : 1,   unit: 'Count' },
    ]);
    if (!passed) {
        log.warn({
            pipelineRunId: env.pipelineRunId,
            slug:          env.slug,
            attempts:      attempts.length,
            finalScore:    qa.data.overallScore,
        }, 'article_qa_gate_flagged');
    }
    return { writer, qa, gate: { attempts, passed, finalAttempt: n, maxRetries: QA_MAX_RETRIES } };
}

/**
 * Deterministic pre-persist normalisation. Overwrites the Writer's frontmatter
 * slug/publishDate/readingTime with canonical values (the served URL routes on
 * env.slug, not the Writer's guess) and strips em-dash connectors from prose.
 * Returns the normalised content and the em-dash replacement count for audit.
 */
function normaliseArticle(content: string, slug: string): { content: string; emDashesReplaced: number } {
    const readingTime = computeReadingTime(content);
    const publishDate = new Date().toISOString().slice(0, 10);
    const reconciled = reconcileFrontmatter(content, { slug, publishDate, readingTime });
    const { content: deDashed, replaced } = stripProseEmDashes(reconciled);
    if (replaced > 0) {
        emitEmfMetric('ArticlePipeline', { Stage: 'emdash-fix' }, [
            { name: 'EmDashReplaced', value: replaced, unit: 'Count' },
        ]);
    }
    return { content: deDashed, emDashesReplaced: replaced };
}

async function main(): Promise<void> {
    const env  = parseEnv();
    const pool = getPool(env.pg);
    const start = process.hrtime.bigint();
    let outcome: 'success' | 'failed' = 'failed';

    const ctx: PipelineContext = {
        pipelineId:        env.pipelineId,
        userId:            env.userId,
        slug:              env.slug,
        sourceKey:         env.s3SourceKey,
        bucket:            env.s3Bucket,
        environment:       env.environment,
        version:           Number.parseInt(process.env['PIPELINE_VERSION'] ?? '1', 10),
        cumulativeTokens:  { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
        retryAttempt:      0,
        startedAt:         new Date().toISOString(),
        onInvocationComplete: recordInvocationToRds(pool, 'article-pipeline'),
    };

    try {
        await updatePipelineRun(pool, env.pipelineRunId, 'researching');
        const research = await timed('research', () => executeResearchAgent(ctx, pool));

        // Fold a structured topic brief (if the article-job carried one) into the
        // research result: its problem/angle seeds the author direction when the
        // draft did not, and its author-confirmed verified metrics reach the
        // Writer's authoritative "Verified Metrics" block (Gap 3). No brief → the
        // research result is used unchanged (draft-only path).
        const brief = env.articleBrief;
        const researchData = brief
            ? {
                ...research.data,
                verifiedMetrics: brief.verifiedMetrics ?? research.data.verifiedMetrics,
                authorDirection: research.data.authorDirection
                    || [brief.problem, brief.angle].filter(Boolean).join(' — '),
              }
            : research.data;

        // Anti-fabrication gate — fails the run (to human review) when no
        // archetype meets its evidence minimums. No-op unless the flag is on.
        gateArchetypeEligibility(env, researchData);

        // Bounded QA gate: write -> review, retry the Writer with QA feedback on a
        // failing verdict (max 2 retries), then either 'review' (pass) or 'flagged'
        // (still failing). Every attempt is captured in `gate` for the review UI.
        await updatePipelineRun(pool, env.pipelineRunId, 'writing');
        const { writer, qa, gate } = await generateWithQaGate(ctx, env, researchData);

        // Deterministic normalisation BEFORE the verifiers and persist: canonical
        // frontmatter (slug/date/readingTime) + em-dash strip. The verifiers then
        // score the exact bytes that get persisted.
        const { content: normalisedContent, emDashesReplaced } =
            normaliseArticle(writer.data.content, env.slug);

        // Post-QA verifiers (flag/record mode, both fail-open) — run pre-persist,
        // neither blocks nor mutates content. Structural lint runs first so its
        // findings can drive the grounding verifier (Phase 2). scrubbedContent is
        // what both see and what gets persisted.
        const scrubbedContent = piiScrubber.scrub(normalisedContent).redacted;
        const lintMeta = await lintArticleStructure(env, writer.data.metadata.title, scrubbedContent);
        const groundingMeta = await verifyArticleGrounding(pool, env, research.data, scrubbedContent);
        const proseMeta = await lintArticleProse(pool, env, scrubbedContent);
        // Evidence adjudication decides the KB-dependent lint findings against the KB.
        const evidenceMeta = await adjudicateArticleEvidence(
            pool, env, lintMeta?.findings ?? [], research.data, scrubbedContent,
        );

        // Final persist — write the rendered MDX back to platform RDS.
        // Use scrubbedContent computed above; grounding flag mode never alters it.
        // Write the Writer's title/excerpt/tags into their own columns so the
        // portfolio (public-api) and admin dashboard render the real SEO metadata,
        // not the placeholder slug. The DB slug (env.slug) stays authoritative;
        // the Writer's frontmatter slug is reconciled to it in normaliseArticle.
        // status: 'review' on a QA pass, 'flagged' when the gate exhausted retries.
        // A confirmed reachable-identifier leak hard-blocks publish regardless of
        // the QA score: 'flagged' routes it to admin review instead of 'review'.
        const disclosureBlocked = hasDisclosureBlocker(lintMeta?.findings ?? []);
        const articleStatus = articleStatusFor(gate.passed && !disclosureBlocked);
        await persistArticle(pool, env.slug, scrubbedContent, env.foundationModel, {
            title:   writer.data.metadata.title,
            excerpt: writer.data.metadata.description,
            tags:    writer.data.metadata.tags,
        }, articleStatus);

        // Attach QA + gate + grounding results to pipeline_runs.metadata (JSONB —
        // no migration needed) so the review UI can show WHY an article needs
        // revision, not just a score, and every failed attempt is inspectable.
        await updatePipelineRunMetadata(
            pool,
            env.pipelineRunId,
            buildRunMetadata(qa.data, gate, groundingMeta, lintMeta, proseMeta, evidenceMeta),
        );

        await updatePipelineRun(pool, env.pipelineRunId, 'complete');
        outcome = 'success';

        log.info({
            pipelineRunId:  env.pipelineRunId,
            slug:           env.slug,
            qaScore:        qa.data.overallScore,
            recommendation: qa.data.recommendation,
            articleStatus,
            qaAttempts:     gate.attempts.length,
            emDashesReplaced,
        }, 'article_pipeline_complete');
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await updatePipelineRun(pool, env.pipelineRunId, 'failed', message)
            .catch(() => { /* swallow — already failing */ });
        log.error({
            pipelineRunId: env.pipelineRunId,
            slug:          env.slug,
            err: message,
        }, 'article_pipeline_failed');
        throw err;
    } finally {
        await closePool();
        const duration = Number(process.hrtime.bigint() - start) / 1e9;
        pipelineRuns.inc({ outcome });
        pipelineDuration.observe({ outcome }, duration);
        // Bounded key: userId when present else "global", never pipelineRunId (see pushgateway.ts).
        await pushFinalMetrics(obs.registry, 'article-pipeline', env.userId ?? 'global');
        await obs.shutdown();
    }
}

main().catch(() => process.exit(1));
