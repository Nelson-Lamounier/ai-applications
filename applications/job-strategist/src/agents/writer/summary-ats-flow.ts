/** @format */
import type { SummaryAtsTarget } from '../../ats/gate/summary-ats-targets.js';
import { scoreSummaryCoverage, type SummaryCoverage } from '../../ats/gate/summary-coverage.js';

/** Per-run summary-ATS diagnostics. Task 6 logs (Loki) and persists this
 *  (pipeline_runs.metadata.analysis.summaryAts). */
export interface SummaryAtsDiagnostics {
  readonly targets: SummaryAtsTarget[];
  readonly coverageBefore: SummaryCoverage;
  readonly rewrite: {
    readonly fired: boolean;
    readonly reason: string | null;
    readonly coverageAfter: SummaryCoverage | null;
    readonly kept: 'first' | 'rewrite' | null;
    readonly keptReason: string | null;
  };
  readonly fallback: { readonly fired: boolean; readonly reason: string | null };
  readonly guardRejections: string[];
}

const MIN_COVERED = 2;

/** Keep-rule extracted for readability and to keep resolveSummaryAts's complexity
 *  low: among guard-passing candidates keep the higher `covered`; on tie / no
 *  coverage gain / re-write-guard-fail -> keep first; prefer the re-write when
 *  the first fails the guard but the re-write is guard-clean. */
function decideKeep(
  firstGuard: string | null,
  rewriteGuard: string | null,
  coverageBefore: SummaryCoverage,
  coverageAfter: SummaryCoverage,
): { kept: 'first' | 'rewrite'; keptReason: string } {
  const firstOk = firstGuard === null;
  const rewriteOk = rewriteGuard === null;
  if (rewriteOk && (!firstOk || coverageAfter.covered > coverageBefore.covered)) {
    return { kept: 'rewrite', keptReason: !firstOk ? 'first-guard-failed' : 'rewrite-covers-more' };
  }
  if (!rewriteOk) return { kept: 'first', keptReason: 'rewrite-guard-failed' };
  if (coverageAfter.covered <= coverageBefore.covered) return { kept: 'first', keptReason: 'no-coverage-gain' };
  return { kept: 'first', keptReason: 'kept-first' };
}

/**
 * Decide the final summary from the first ATS-aware draft: score coverage, and if
 * below the minimum with targets present, invoke ONE bounded re-write, then keep the
 * better guard-passing candidate.
 *
 * Pure of Bedrock/DB -- `guard` and `rewrite` are injected so the decision logic is
 * unit-testable. `guard` returns the name of the first violated guard, or null when
 * clean. The selection guard is a PREFERENCE, not a hard gate: the authoritative
 * word-cap/altitude/fit-thesis enforcement is the unchanged downstream ResumeGuardCtx
 * + summary-repair pass. Worst case (both candidates guard-fail) equals today's
 * behaviour: the first summary is used and handed to that downstream pass.
 *
 * Trigger: the re-write fires ONLY when coverage is below MIN_COVERED with targets
 * present. The namesGap guard is a KEEP-RULE preference used to choose between the
 * first draft and the re-write once one has fired -- it is NOT a fire trigger. A
 * first draft that trips namesGap at adequate coverage is left to the downstream
 * ResumeGuardCtx + summary-repair pass, which owns truthfulness repair.
 */
export async function resolveSummaryAts(params: {
  readonly firstSummary: string;
  readonly targets: readonly SummaryAtsTarget[];
  readonly guard: (summary: string) => string | null;
  readonly rewrite: (draft: string, missing: string[]) => Promise<string>;
}): Promise<{ summary: string; diag: SummaryAtsDiagnostics }> {
  const targets = [...params.targets];
  const coverageBefore = scoreSummaryCoverage(params.firstSummary, targets);
  const guardRejections: string[] = [];
  const firstGuard = params.guard(params.firstSummary);
  if (firstGuard) guardRejections.push(`first:${firstGuard}`);

  const noRewrite = (reason: string): { summary: string; diag: SummaryAtsDiagnostics } => ({
    summary: params.firstSummary,
    diag: {
      targets, coverageBefore,
      rewrite: { fired: false, reason, coverageAfter: null, kept: null, keptReason: null },
      fallback: { fired: false, reason: null },
      guardRejections,
    },
  });

  const coverageShort = coverageBefore.covered < MIN_COVERED;
  if (targets.length === 0) return noRewrite('no-targets');
  if (!coverageShort) return noRewrite('coverage-met');

  let rewriteSummary: string;
  try {
    rewriteSummary = await params.rewrite(params.firstSummary, coverageBefore.missing);
  } catch {
    return {
      summary: params.firstSummary,
      diag: {
        targets, coverageBefore,
        rewrite: { fired: true, reason: 'rewrite-error', coverageAfter: null, kept: 'first', keptReason: 'rewrite-threw' },
        fallback: { fired: false, reason: null },
        guardRejections,
      },
    };
  }

  const coverageAfter = scoreSummaryCoverage(rewriteSummary, targets);
  const rewriteGuard = params.guard(rewriteSummary);
  if (rewriteGuard) guardRejections.push(`rewrite:${rewriteGuard}`);

  const { kept, keptReason } = decideKeep(firstGuard, rewriteGuard, coverageBefore, coverageAfter);
  const reason = 'coverage-below-min';
  return {
    summary: kept === 'rewrite' ? rewriteSummary : params.firstSummary,
    diag: {
      targets, coverageBefore,
      rewrite: { fired: true, reason, coverageAfter, kept, keptReason },
      fallback: { fired: false, reason: null },
      guardRejections,
    },
  };
}
