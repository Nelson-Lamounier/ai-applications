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
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { computeUserProfileRollup, computeUserDiagnostic } from '@bedrock/shared';
import type { IUserProfileRollupRepository } from '@bedrock/shared';
import type { MirrorRevealSynthesizer } from '../agents/MirrorRevealSynthesizer.js';
import type { DirectionSynthesizer } from '../agents/DirectionSynthesizer.js';
import type { ReconciliationSynthesizer } from '../agents/ReconciliationSynthesizer.js';
import type { ICareerHistoryReadRepository } from '@bedrock/shared';
import type { DiagnosticNarrator } from '../agents/DiagnosticNarrator.js';
import type { IDiagnosticInputsReadRepository, DiagnosticJson } from '@bedrock/shared';

const tracer = trace.getTracer('ingestion-worker');

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
            let synth: Awaited<ReturnType<MirrorRevealSynthesizer['synthesize']>> | undefined;
            if (synthesizer) {
                try { synth = await synthesizer.synthesize(result.rollup); }
                catch { synth = undefined; }
            }
            let dir: Awaited<ReturnType<DirectionSynthesizer['synthesize']>> | undefined;
            if (directionSynthesizer) {
                try { dir = await directionSynthesizer.synthesize(result.rollup); }
                catch { dir = undefined; }
            }
            let recon: Awaited<ReturnType<ReconciliationSynthesizer['synthesize']>> | undefined;
            if (reconciliationSynthesizer && careerRepo) {
                try {
                    const resume = await careerRepo.getResumeForReconciliation(userId);
                    if (resume) recon = await reconciliationSynthesizer.synthesize({ rollup: result.rollup, resume });
                } catch { recon = undefined; }
            }
            let diagnostic: DiagnosticJson | undefined;
            if (diagnosticInputsRepo) {
                try {
                    const di = await diagnosticInputsRepo.getDiagnosticInputs(userId);
                    const computed = computeUserDiagnostic({
                        rollup:         result.rollup,
                        mirror:         synth?.mirror         ?? null,
                        reveal:         synth?.reveal         ?? null,
                        direction:      dir?.direction        ?? null,
                        reconciliation: recon?.reconciliation ?? null,
                        diagnosticInputs: di,
                    });
                    let explanation: string | null = null;
                    if (narrator) {
                        try { explanation = (await narrator.narrate(computed)) ?? null; }
                        catch { explanation = null; }
                    }
                    diagnostic = { ...computed, explanation };
                } catch { diagnostic = undefined; }
            }
            await repo.upsert(userId, result, synth?.mirror, synth?.reveal, dir?.direction, recon?.reconciliation, diagnostic);
            span.setAttributes({
                'profile_rollup.project_repos': result.projectRepoCount,
                'profile_rollup.synthesized':   Boolean(synth),
                'profile_rollup.directioned':   Boolean(dir),
                'profile_rollup.reconciled':    Boolean(recon),
                'profile_rollup.diagnosed':     Boolean(diagnostic),
            });
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
