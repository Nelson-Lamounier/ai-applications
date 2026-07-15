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
}

/** Flattened score text for an experience output: every role's bullets, in order. */
export function joinExperienceText(out: ExperienceAgentOutput): string {
  return assembleExperience(out).flatMap((r) => r.highlights).join('. ');
}

/** Every role's RAW bullets ({text, sources}), flattened for the
 *  evidence-anchored coverage scorer -- `sources` lives on the raw
 *  ExperienceAgentOutput bullet; `assembleExperience`/`joinExperienceText`
 *  discard it once the section is final, so this reads the pre-assembly
 *  output instead. */
function bulletsOf(out: ExperienceAgentOutput): ScorableBullet[] {
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
    },
  };
}
