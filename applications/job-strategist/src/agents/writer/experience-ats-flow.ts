/** @format */
import type { ExperienceAtsTarget } from '../../ats/gate/experience-ats-targets.js';
import { scoreExperienceCoverage, type ScorableBullet } from '../../ats/gate/experience-coverage.js';
import type { SummaryCoverage } from '../../ats/gate/summary-coverage.js';
import { namesGap } from '../quality/guards/summary-rules.js';
import {
  assembleExperience, validateExperienceProvenance,
  type IndexedCareerLine, type RosterEntry,
} from './experience-provenance.js';
import type { ExperienceAgentOutput } from './experience-schema.js';

/** A single unused career line the experience agent declared instead of citing.
 *  Bounded before it reaches Loki/DB -- see boundDropped. */
export interface DroppedLine { readonly line: string; readonly reason: string; }

const MAX_DROPPED_ENTRIES = 30;
const MAX_DROPPED_REASON_CHARS = 200;

/** Bound the raw accounting.dropped array before it is logged or persisted: cap
 *  the entry count and per-reason length so a pathological agent response
 *  cannot blow up a Loki log line or the pipeline_runs metadata payload. */
export function boundDropped(dropped: ReadonlyArray<{ line: string; reason: string }>): DroppedLine[] {
  return dropped.slice(0, MAX_DROPPED_ENTRIES).map((d) => ({
    line: d.line,
    reason: d.reason.length > MAX_DROPPED_REASON_CHARS ? d.reason.slice(0, MAX_DROPPED_REASON_CHARS) : d.reason,
  }));
}

/** Per-run experience-ATS diagnostics. Logged (Loki) and persisted alongside the
 *  summary-ATS diagnostics (pipeline_runs.metadata.analysis.experienceAgent). */
export interface ExperienceAgentDiagnostics {
  readonly targets: ExperienceAtsTarget[];
  readonly coverageBefore: SummaryCoverage;
  readonly rewrite: {
    readonly fired: boolean;
    readonly reason: string | null;
    readonly coverageAfter: SummaryCoverage | null;
    readonly kept: 'first' | 'rewrite' | null;
    readonly keptReason: string | null;
  };
  readonly fallback: { readonly fired: boolean; readonly reason: string | null };
  readonly provenance: {
    readonly firstViolations: string[];
    readonly rewriteViolations: string[];
    readonly droppedLines: number;
    readonly dropped: DroppedLine[];
  };
  /** Final-text coverage (Task 4) -- null until `stampExperienceCoverageFinal`
   *  scores the text that actually ships, immediately before the metadata
   *  write. Scored with the SAME scorer as `coverageBefore`/`coverageAfter`,
   *  against the `kept` output's bullets -- their `sources` remain valid
   *  because Experience is locked immutable after this flow runs (see
   *  experience-lock.ts). Stays null on the verbatim-career fallback path
   *  (no agent output to score against). */
  readonly coverageFinal: SummaryCoverage | null;
}

/** Flattened score text for an experience output: every role's bullets, in order. */
export function joinExperienceText(out: ExperienceAgentOutput): string {
  return assembleExperience(out).flatMap((r) => r.highlights).join('. ');
}

/** Every role's RAW bullets ({text, sources}), flattened for the
 *  evidence-anchored coverage scorer -- `sources` lives on the raw
 *  ExperienceAgentOutput bullet; `assembleExperience`/`joinExperienceText`
 *  discard it once the section is final, so this reads the pre-assembly
 *  output instead. Exported so the eval graders (experience-graders.ts) score
 *  against the EXACT same bullet shape the runtime scorer uses -- graders
 *  reuse runtime logic, never a re-derived shape. */
export function bulletsOf(out: ExperienceAgentOutput): ScorableBullet[] {
  return out.roles.flatMap((r) => r.highlights.map((h) => ({ text: h.text, sources: h.sources })));
}

/** Draft text handed to the re-write fn: per-role `company | title` header, then
 *  `- bullet` lines, roles separated by a blank line. */
function buildDraftText(out: ExperienceAgentOutput): string {
  return assembleExperience(out)
    .map((r) => [`${r.company} | ${r.title}`, ...r.highlights.map((h) => `- ${h}`)].join('\n'))
    .join('\n\n');
}

/** Keep-rule extracted for readability and to keep resolveExperienceAts's complexity
 *  low: prefer the re-write when it is guard-clean (provenance-valid + no namesGap
 *  bullet) AND covers strictly more targets than the first draft; otherwise keep
 *  first -- covering the tie / no-gain / provenance-invalid / namesGap cases with a
 *  single, precise `keptReason`. */
function decideKeepExperience(
  firstCovered: number,
  rewriteCovered: number,
  rewriteValid: boolean,
  invalidReason: string,
): { kept: 'first' | 'rewrite'; keptReason: string } {
  if (rewriteValid && rewriteCovered > firstCovered) {
    return { kept: 'rewrite', keptReason: 'rewrite-covers-more' };
  }
  if (!rewriteValid) return { kept: 'first', keptReason: invalidReason };
  return { kept: 'first', keptReason: 'no-coverage-gain' };
}

/**
 * Decide the final experience section from the first ATS-aware draft: score
 * coverage, and if any target is missing, invoke ONE bounded re-write, then keep
 * the better provenance-guarded candidate.
 *
 * PRECONDITION: `params.first` has already been validated by the caller -- an
 * invalid or errored first pass never reaches this function (it goes to the
 * verbatim-career fallback instead). `diag.provenance.firstViolations` is
 * therefore always `[]` here; it is not re-derived.
 *
 * Fire rule: the re-write fires ONLY when `targets.length > 0` and coverage is
 * strictly below `targets.length` (every attainable target must appear, unlike
 * the summary lane's MIN_COVERED threshold -- the experience section has far
 * more room to carry every target). The kept-candidate guard is a PREFERENCE
 * used to choose between the first draft and the re-write once one has fired:
 * the re-write must be provenance-valid (`validateExperienceProvenance`) AND no
 * bullet trips `namesGap`, or it is discarded in favour of the (already-valid)
 * first draft. Worst case (re-write invalid or no gain) equals today's
 * behaviour: the first, already-validated draft is used.
 */
export async function resolveExperienceAts(params: {
  readonly first: ExperienceAgentOutput;
  readonly roster: readonly RosterEntry[];
  readonly careerLines: readonly IndexedCareerLine[];
  readonly targets: readonly ExperienceAtsTarget[];
  readonly rewrite: (draftText: string, missing: string[]) => Promise<ExperienceAgentOutput>;
}): Promise<{ output: ExperienceAgentOutput; diag: ExperienceAgentDiagnostics }> {
  const targets = [...params.targets];
  const coverageBefore = scoreExperienceCoverage(bulletsOf(params.first), targets);

  const noRewrite = (reason: string): { output: ExperienceAgentOutput; diag: ExperienceAgentDiagnostics } => ({
    output: params.first,
    diag: {
      targets, coverageBefore,
      rewrite: { fired: false, reason, coverageAfter: null, kept: null, keptReason: null },
      fallback: { fired: false, reason: null },
      provenance: {
        firstViolations: [], rewriteViolations: [],
        droppedLines: params.first.accounting.dropped.length,
        dropped: boundDropped(params.first.accounting.dropped),
      },
      coverageFinal: null,
    },
  });

  if (targets.length === 0) return noRewrite('no-targets');
  if (coverageBefore.covered >= targets.length) return noRewrite('coverage-met');

  const draftText = buildDraftText(params.first);
  let rewriteOut: ExperienceAgentOutput;
  try {
    rewriteOut = await params.rewrite(draftText, coverageBefore.missing);
  } catch {
    return {
      output: params.first,
      diag: {
        targets, coverageBefore,
        rewrite: { fired: true, reason: 'rewrite-error', coverageAfter: null, kept: 'first', keptReason: 'rewrite-threw' },
        fallback: { fired: false, reason: null },
        provenance: {
          firstViolations: [], rewriteViolations: [],
          droppedLines: params.first.accounting.dropped.length,
          dropped: boundDropped(params.first.accounting.dropped),
        },
        coverageFinal: null,
      },
    };
  }

  const coverageAfter = scoreExperienceCoverage(bulletsOf(rewriteOut), targets);
  const rewriteViolations = validateExperienceProvenance(rewriteOut, params.roster, params.careerLines);
  const rewriteGapped = assembleExperience(rewriteOut).some((r) => r.highlights.some((h) => namesGap(h)));
  const rewriteValid = rewriteViolations.length === 0 && !rewriteGapped;
  const invalidReason = rewriteViolations.length > 0 ? 'rewrite-provenance-invalid' : 'rewrite-names-gap';

  const { kept, keptReason } = decideKeepExperience(coverageBefore.covered, coverageAfter.covered, rewriteValid, invalidReason);
  const output = kept === 'rewrite' ? rewriteOut : params.first;
  return {
    output,
    diag: {
      targets, coverageBefore,
      rewrite: { fired: true, reason: 'coverage-below-targets', coverageAfter, kept, keptReason },
      fallback: { fired: false, reason: null },
      provenance: {
        firstViolations: [], rewriteViolations,
        droppedLines: output.accounting.dropped.length,
        dropped: boundDropped(output.accounting.dropped),
      },
      coverageFinal: null,
    },
  };
}

/**
 * Final-text coverage (Task 4): score the SAME way as `coverageBefore`/
 * `coverageAfter`, against the OUTPUT the flow actually kept -- Experience is
 * locked immutable after `fillResumeExperience` runs (experience-lock.ts), so
 * `kept`'s bullet `sources` remain valid for whatever text ships. Returns a
 * NEW diagnostics object (every field on `ExperienceAgentDiagnostics` is
 * readonly) -- call this exactly once, immediately before the metadata write.
 */
export function stampExperienceCoverageFinal(
  diag: ExperienceAgentDiagnostics,
  kept: ExperienceAgentOutput,
): ExperienceAgentDiagnostics {
  return { ...diag, coverageFinal: scoreExperienceCoverage(bulletsOf(kept), diag.targets) };
}

/**
 * Downstream-mutation assert (Task 4): `withExperienceLock` (experience-lock.ts)
 * already ENFORCES that no wrapped pass can drift Experience -- this is the
 * final PROOF, a byte-for-byte compare of the section that actually shipped
 * against `assembleExperience(kept)`. `true` means some pass mutated
 * Experience OUTSIDE the lock; the caller records it
 * (resume_integrity/experience_mutated_downstream) and moves on -- an
 * integrity signal, never a gate (fail-open, this never throws).
 */
export function experienceMutatedDownstream(
  finalExperience: ReturnType<typeof assembleExperience>,
  kept: ExperienceAgentOutput,
): boolean {
  return JSON.stringify(finalExperience) !== JSON.stringify(assembleExperience(kept));
}

export interface JdEchoRouteResult {
  readonly output: ExperienceAgentOutput;
  readonly rewritten: boolean;
}

/**
 * Route advisory `experience_bullet_jd_echo` guard violations to ONE
 * provenance-guarded re-write (Task 4, G2 tail). `guardResume`'s own
 * rule-based repair on Experience is undone by the Task-2 lock (Experience is
 * agent-owned) -- this is the only path that can actually FIX an echoing
 * bullet post-fill, rather than just report it.
 *
 * Fires at most once: `echoDetails.length === 0` short-circuits with no call.
 * `rewrite` receives the RAW flagged-detail strings -- the caller renders
 * them into the prompt via `ExperienceMessageInput.echoCleanup` (a
 * purpose-built message block, review-fixed: this used to stuff a composed
 * instruction string into the unrelated ATS `rewriteDraft`/`rewriteMissing`
 * fields, which rendered under the wrong heading). The re-write is validated
 * exactly like the ATS re-write (`validateExperienceProvenance`); an invalid
 * or throwing re-write is discarded and the ORIGINAL `kept` output stands --
 * the flagged violations stay advisory, never block the run.
 */
export async function routeJdEchoRewrite(params: {
  readonly kept: ExperienceAgentOutput;
  readonly roster: readonly RosterEntry[];
  readonly careerLines: readonly IndexedCareerLine[];
  readonly echoDetails: readonly string[];
  readonly rewrite: (flaggedDetails: readonly string[]) => Promise<ExperienceAgentOutput>;
}): Promise<JdEchoRouteResult> {
  const { kept, roster, careerLines, echoDetails, rewrite } = params;
  if (echoDetails.length === 0) return { output: kept, rewritten: false };
  let rewriteOut: ExperienceAgentOutput;
  try {
    rewriteOut = await rewrite(echoDetails);
  } catch {
    return { output: kept, rewritten: false };
  }
  const violations = validateExperienceProvenance(rewriteOut, roster, careerLines);
  if (violations.length > 0) return { output: kept, rewritten: false };
  return { output: rewriteOut, rewritten: true };
}
