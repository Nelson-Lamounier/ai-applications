/**
 * @format
 * refreshUserProfileRollup — best-effort per-user rollup refresh.
 *
 * Called at the end of a successful profile extraction. Recomputes the
 * user's ENTIRE rollup (re-reads all their repository_profiles), so it is
 * self-healing and eventually consistent under parallel same-user jobs.
 * MUST NOT throw — a rollup failure must never fail ingestion (same
 * best-effort contract as the retrieval probe).
 */
import { createHash } from 'node:crypto';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { computeUserProfileRollup, computeUserDiagnostic } from '@bedrock/shared';
import { synthesisOutcomeTotal } from '../metrics.js';
import type { IUserProfileRollupRepository } from '@bedrock/shared';
import type { MirrorRevealSynthesizer } from '../agents/MirrorRevealSynthesizer.js';
import type { DirectionSynthesizer } from '../agents/DirectionSynthesizer.js';
import type { ReconciliationSynthesizer } from '../agents/ReconciliationSynthesizer.js';
import type { ICareerHistoryReadRepository } from '@bedrock/shared';
import type { DiagnosticNarrator } from '../agents/DiagnosticNarrator.js';
import type { IDiagnosticInputsReadRepository, DiagnosticJson } from '@bedrock/shared';

const tracer = trace.getTracer('ingestion-worker');

const STAGE = { mirror: 'mirror', direction: 'direction', reconciliation: 'reconciliation', diagnostic: 'diagnostic' } as const;
const OUTCOME = { ok: 'ok', failed: 'failed', skipped: 'skipped' } as const;

type SynthMetric = ReturnType<typeof synthesisOutcomeTotal>;
type MirrorReveal = Awaited<ReturnType<MirrorRevealSynthesizer['synthesize']>>;
type Direction = Awaited<ReturnType<DirectionSynthesizer['synthesize']>>;
type Reconciliation = Awaited<ReturnType<ReconciliationSynthesizer['synthesize']>>;

/**
 * Runs a value-returning synthesis stage. The synthesizer resolves to
 * `undefined` (not a throw) on schema-invalid / truncated output, so the
 * metric outcome is keyed off the result — otherwise a NULL synthesis would
 * be miscounted as 'ok'.
 */
async function runSynthStage<T>(
    stage: string,
    metric: SynthMetric,
    fn: (() => Promise<T | undefined>) | undefined,
): Promise<T | undefined> {
    if (!fn) { metric.inc({ stage, outcome: OUTCOME.skipped }); return undefined; }
    try {
        const value = await fn();
        metric.inc({ stage, outcome: value ? OUTCOME.ok : OUTCOME.failed });
        return value;
    } catch {
        metric.inc({ stage, outcome: OUTCOME.failed });
        return undefined;
    }
}

async function runReconciliationStage(
    metric: SynthMetric,
    userId: string,
    rollup: ReturnType<typeof computeUserProfileRollup>['rollup'],
    reconciliationSynthesizer?: ReconciliationSynthesizer,
    careerRepo?: ICareerHistoryReadRepository,
): Promise<{ value: Reconciliation; attempted: boolean }> {
    if (!reconciliationSynthesizer || !careerRepo) {
        metric.inc({ stage: STAGE.reconciliation, outcome: OUTCOME.skipped });
        return { value: undefined, attempted: false };
    }
    try {
        const resume = await careerRepo.getResumeForReconciliation(userId);
        if (!resume) {
            // No résumé imported — reconciliation has nothing to compare against.
            metric.inc({ stage: STAGE.reconciliation, outcome: OUTCOME.skipped });
            return { value: undefined, attempted: false };
        }
        const value = await reconciliationSynthesizer.synthesize({ rollup, resume });
        metric.inc({ stage: STAGE.reconciliation, outcome: value ? OUTCOME.ok : OUTCOME.failed });
        return { value, attempted: true };
    } catch {
        metric.inc({ stage: STAGE.reconciliation, outcome: OUTCOME.failed });
        return { value: undefined, attempted: true };
    }
}

async function runDiagnosticStage(
    metric: SynthMetric,
    userId: string,
    inputs: Omit<Parameters<typeof computeUserDiagnostic>[0], 'diagnosticInputs'>,
    diagnosticInputsRepo?: IDiagnosticInputsReadRepository,
    narrator?: DiagnosticNarrator,
): Promise<DiagnosticJson | undefined> {
    if (!diagnosticInputsRepo) { metric.inc({ stage: STAGE.diagnostic, outcome: OUTCOME.skipped }); return undefined; }
    try {
        const di = await diagnosticInputsRepo.getDiagnosticInputs(userId);
        const computed = computeUserDiagnostic({ ...inputs, diagnosticInputs: di });
        let explanation: string | null = null;
        if (narrator) {
            try { explanation = (await narrator.narrate(computed)) ?? null; }
            catch { explanation = null; }
        }
        metric.inc({ stage: STAGE.diagnostic, outcome: OUTCOME.ok });
        return { ...computed, explanation };
    } catch {
        metric.inc({ stage: STAGE.diagnostic, outcome: OUTCOME.failed });
        return undefined;
    }
}

/**
 * Attempted-but-empty synthesis leaves the overview panels on "still being
 * generated". Best-effort never throws, so make a partial result loud here.
 */
function reportPartialSynthesis(
    span: Span,
    userId: string,
    stages: { stage: string; attempted: boolean; produced: boolean }[],
): void {
    const failed = stages.filter((s) => s.attempted && !s.produced).map((s) => s.stage);
    if (failed.length === 0) return;
    span.setAttribute('profile_rollup.synthesis_partial', failed.join(','));
    span.setStatus({ code: SpanStatusCode.ERROR, message: `synthesis incomplete: ${failed.join(', ')}` });
    console.warn(`[refreshUserProfileRollup] synthesis incomplete for user ${userId} — empty: ${failed.join(', ')}`);
}

/**
 * WS4 synthesis-skip gate: if the aggregate rollup hash is unchanged AND synthesis
 * already exists, re-stamp the rollup (COALESCE preserves prior synthesis) and
 * return true so the caller skips the 3-4 LLM calls. Keyed on the aggregate, so
 * add/delete/modify of any repo changes the hash and forces a re-synthesis.
 */
async function trySkipSynthesis(
    repo: IUserProfileRollupRepository,
    userId: string,
    result: ReturnType<typeof computeUserProfileRollup>,
    rollupHash: string,
): Promise<boolean> {
    const prior = (await repo.getSynthesisState?.(userId)) ?? null;
    if (!prior || prior.inputHash !== rollupHash || !prior.hasSynthesis) return false;
    await repo.upsert(userId, result, undefined, undefined, undefined, undefined, undefined, rollupHash);
    return true;
}

export async function refreshUserProfileRollup(
    repo: IUserProfileRollupRepository,
    userId: string,
    synthesizer?: MirrorRevealSynthesizer,
    directionSynthesizer?: DirectionSynthesizer,
    reconciliationSynthesizer?: ReconciliationSynthesizer,
    careerRepo?: ICareerHistoryReadRepository,
    narrator?: DiagnosticNarrator,
    diagnosticInputsRepo?: IDiagnosticInputsReadRepository,
): Promise<void> {
    await tracer.startActiveSpan('ingestion.profile_rollup', async (span) => {
        try {
            const rows   = await repo.listProfilesForRollup(userId);
            const result = computeUserProfileRollup(rows);

            // Skip-unchanged gate (WS4): the synthesis LLMs are a pure function of
            // the aggregate rollup. Hash it; if unchanged AND synthesis already
            // exists, skip the 3-4 LLM calls and just re-stamp the rollup (COALESCE
            // preserves the prior synthesis). Keyed on the AGGREGATE, so adding,
            // deleting, or modifying ANY repo changes the hash and forces a re-run.
            const rollupHash = createHash('sha256').update(JSON.stringify(result.rollup)).digest('hex');
            if (await trySkipSynthesis(repo, userId, result, rollupHash)) {
                span.setAttribute('profile_rollup.synthesis_skipped', true);
                console.info(`[refreshUserProfileRollup] rollup unchanged for user ${userId} — synthesis skipped (no LLM calls)`);
                return;
            }

            const synthMetric = synthesisOutcomeTotal();

            // Mirror, direction, and reconciliation are independent layers over
            // the same source rollup (none consumes another's output), so run
            // them concurrently — this cuts the tail latency from the sum of the
            // three Sonnet calls (~110s observed) to the slowest single one.
            // Diagnostic stays last: it genuinely depends on all three outputs.
            const [synth, dir, reconStage]: [MirrorReveal, Direction, Awaited<ReturnType<typeof runReconciliationStage>>] =
                await Promise.all([
                    runSynthStage(STAGE.mirror, synthMetric,
                        synthesizer ? () => synthesizer.synthesize(result.rollup) : undefined),
                    runSynthStage(STAGE.direction, synthMetric,
                        directionSynthesizer ? () => directionSynthesizer.synthesize(result.rollup) : undefined),
                    runReconciliationStage(
                        synthMetric, userId, result.rollup, reconciliationSynthesizer, careerRepo),
                ]);
            const { value: recon, attempted: reconAttempted } = reconStage;
            const diagnostic = await runDiagnosticStage(synthMetric, userId, {
                rollup:         result.rollup,
                mirror:         synth?.mirror         ?? null,
                reveal:         synth?.reveal         ?? null,
                direction:      dir?.direction        ?? null,
                reconciliation: recon?.reconciliation ?? null,
            }, diagnosticInputsRepo, narrator);

            await repo.upsert(userId, result, synth?.mirror, synth?.reveal, dir?.direction, recon?.reconciliation, diagnostic, rollupHash);
            span.setAttributes({
                'profile_rollup.project_repos': result.projectRepoCount,
                'profile_rollup.synthesized':   Boolean(synth),
                'profile_rollup.directioned':   Boolean(dir),
                'profile_rollup.reconciled':    Boolean(recon),
                'profile_rollup.diagnosed':     Boolean(diagnostic),
            });

            reportPartialSynthesis(span, userId, [
                { stage: STAGE.mirror,         attempted: Boolean(synthesizer),          produced: Boolean(synth) },
                { stage: STAGE.direction,      attempted: Boolean(directionSynthesizer), produced: Boolean(dir) },
                { stage: STAGE.reconciliation, attempted: reconAttempted,                produced: Boolean(recon) },
            ]);
        } catch (err) {
            // Best-effort: a rollup failure MUST NOT break ingestion.
            // Log to the span, swallow, continue.
            span.recordException(err instanceof Error ? err : new Error(String(err)));
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        } finally {
            span.end();
        }
    });
}
