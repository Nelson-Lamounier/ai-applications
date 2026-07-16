/** @format */
import type { ExperienceAtsTarget } from '../../ats/gate/experience-ats-targets.js';
import { scoreSummaryCoverage, type SummaryCoverage } from '../../ats/gate/summary-coverage.js';
import type { ProjectPoolEntry } from '../evidence/project-agent-inputs.js';
import { assembleProjects, validateProjectsProvenance } from './projects-provenance.js';
import { isCurated, type ProjectsAgentOutput } from './projects-schema.js';

const MAX_BULLETS = 6;
const MAX_DESCRIPTION_WORDS = 40;

/** Per-run projects-ATS diagnostics. Logged (Loki) and persisted alongside the
 *  summary/experience-ATS diagnostics (pipeline_runs.metadata.analysis.projectsAgent).
 *
 *  `unresolvedRepos` is NOT populated by this module -- `resolveProjectsAts` always
 *  sets it to `[]`. It is injected by the run-pipeline caller from
 *  `ProjectAgentInputs.unresolvedRepos` (Task 8), which knows about citations that
 *  failed to resolve to a known repository during pool construction -- a fact this
 *  function has no visibility into.
 *
 *  `normalisedExtras` is likewise NOT populated by this module -- it always sets
 *  it to `0`. It is injected by the run-pipeline caller (fillResumeProjects) from
 *  executeProjectsAgent's returned `normalisedExtras` (summed across the first
 *  draft and any re-write call) -- the schema-tolerance strip count from
 *  normaliseProjectsAgentOutput, a fact this function has no visibility into. */
export interface ProjectsAgentDiagnostics {
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
  readonly provenance: { readonly firstViolations: string[]; readonly rewriteViolations: string[]; readonly composedCount: number };
  readonly normalisedExtras: number;
  readonly unresolvedRepos: string[];
}

/** Flattened score text for a projects output: every project's description
 *  followed by its assembled highlights, in order. */
export function joinProjectsText(out: ProjectsAgentOutput, pool: readonly ProjectPoolEntry[]): string {
  return assembleProjects(out, pool)
    .flatMap((p) => [p.description, ...p.highlights])
    .join('. ');
}

/** Draft text handed to the re-write fn: per-project `name` line, then
 *  `- bullet` lines, projects separated by a blank line. */
function buildDraftText(out: ProjectsAgentOutput, pool: readonly ProjectPoolEntry[]): string {
  return assembleProjects(out, pool)
    .map((p) => [p.name, ...p.highlights.map((h) => `- ${h}`)].join('\n'))
    .join('\n\n');
}

/** Number of composed (model-authored) highlights across every entry in an
 *  output -- curated highlights resolve to pre-written pool text and do not
 *  count. Used for the `provenance.composedCount` diagnostic on the KEPT output. */
function countComposed(out: ProjectsAgentOutput): number {
  return out.entries.reduce((n, e) => n + e.highlights.filter((h) => !isCurated(h)).length, 0);
}

/** Keep-rule extracted for readability and to keep resolveProjectsAts's complexity
 *  low: prefer the re-write when it is provenance-clean AND covers strictly more
 *  targets than the first draft; otherwise keep first -- covering the tie /
 *  no-gain / provenance-invalid cases with a single, precise `keptReason`.
 *  Unlike the experience lane, there is no separate `namesGap` guard here --
 *  projects highlights are project-scoped facts, not tenure claims. */
function decideKeepProjects(
  firstCovered: number,
  rewriteCovered: number,
  rewriteValid: boolean,
): { kept: 'first' | 'rewrite'; keptReason: string } {
  if (rewriteValid && rewriteCovered > firstCovered) {
    return { kept: 'rewrite', keptReason: 'rewrite-covers-more' };
  }
  if (!rewriteValid) return { kept: 'first', keptReason: 'rewrite-provenance-invalid' };
  return { kept: 'first', keptReason: 'no-coverage-gain' };
}

/** Per-pool-entry deterministic fallback: rank curated bullets by ATS-target
 *  coverage (stable on ties, i.e. original order), take at most MAX_BULLETS.
 *  Description is the pitch's first MAX_DESCRIPTION_WORDS words; github is the
 *  project's first known repo URL. Projects with no curated bullets are skipped
 *  entirely (there is nothing safe to say about them without the model). */
function rankProjectEntry(
  entry: ProjectPoolEntry,
  targets: readonly ExperienceAtsTarget[],
): { name: string; description: string; github?: string; highlights: string[] } {
  const ranked = entry.curated
    .map((bullet, idx) => ({ bullet, idx, covered: scoreSummaryCoverage(bullet.text, targets).covered }))
    .sort((a, b) => b.covered - a.covered || a.idx - b.idx);
  const highlights = ranked.slice(0, MAX_BULLETS).map((r) => r.bullet.text);

  const pitchWords = entry.pitch.trim().split(/\s+/).filter((w) => w.length > 0);
  const description = pitchWords.slice(0, MAX_DESCRIPTION_WORDS).join(' ');

  const github = entry.repoUrls[0];
  return { name: entry.name, description, ...(github !== undefined ? { github } : {}), highlights };
}

/** Deterministic (no-LLM) fallback for the projects section: used when the first
 *  ATS-aware draft fails validation and must not reach the model again. Only
 *  pool entries with a non-empty curated lane are emitted -- there is no safe
 *  deterministic content for a project with nothing curated yet. */
export function deterministicProjects(
  pool: readonly ProjectPoolEntry[],
  targets: readonly ExperienceAtsTarget[],
): Array<{ name: string; description: string; github?: string; highlights: string[] }> {
  return pool.filter((p) => p.curated.length > 0).map((p) => rankProjectEntry(p, targets));
}

/**
 * Decide the final projects section from the first ATS-aware draft: score
 * coverage, and if any target is missing, invoke ONE bounded re-write, then keep
 * the better provenance-guarded candidate.
 *
 * PRECONDITION: `params.first` has already been validated by the caller -- an
 * invalid or errored first pass never reaches this function (it goes to the
 * `deterministicProjects` fallback instead). `diag.provenance.firstViolations`
 * is therefore always `[]` here; it is not re-derived. `diag.unresolvedRepos`
 * is always `[]` here too -- see the `ProjectsAgentDiagnostics` doc comment.
 *
 * Fire rule: the re-write fires ONLY when `targets.length > 0` and coverage is
 * strictly below `targets.length` -- every attainable target must appear in the
 * projects section, mirroring the experience lane (not the summary lane's
 * MIN_COVERED threshold). The kept-candidate guard is a PREFERENCE used to
 * choose between the first draft and the re-write once one has fired: the
 * re-write must be provenance-valid (`validateProjectsProvenance`, which also
 * enforces cross-project citation isolation), or it is discarded in favour of
 * the (already-valid) first draft. Worst case (re-write invalid or no gain)
 * equals today's behaviour: the first, already-validated draft is used.
 */
export async function resolveProjectsAts(params: {
  readonly first: ProjectsAgentOutput;
  readonly pool: readonly ProjectPoolEntry[];
  readonly targets: readonly ExperienceAtsTarget[];
  readonly rewrite: (draftText: string, missing: string[]) => Promise<ProjectsAgentOutput>;
}): Promise<{ output: ProjectsAgentOutput; diag: ProjectsAgentDiagnostics }> {
  const targets = [...params.targets];
  const coverageBefore = scoreSummaryCoverage(joinProjectsText(params.first, params.pool), targets);

  const noRewrite = (reason: string): { output: ProjectsAgentOutput; diag: ProjectsAgentDiagnostics } => ({
    output: params.first,
    diag: {
      targets, coverageBefore,
      rewrite: { fired: false, reason, coverageAfter: null, kept: null, keptReason: null },
      fallback: { fired: false, reason: null },
      provenance: { firstViolations: [], rewriteViolations: [], composedCount: countComposed(params.first) },
      unresolvedRepos: [],
      normalisedExtras: 0,
    },
  });

  if (targets.length === 0) return noRewrite('no-targets');
  if (coverageBefore.covered >= targets.length) return noRewrite('coverage-met');

  const draftText = buildDraftText(params.first, params.pool);
  let rewriteOut: ProjectsAgentOutput;
  try {
    rewriteOut = await params.rewrite(draftText, coverageBefore.missing);
  } catch {
    return {
      output: params.first,
      diag: {
        targets, coverageBefore,
        rewrite: { fired: true, reason: 'rewrite-error', coverageAfter: null, kept: 'first', keptReason: 'rewrite-threw' },
        fallback: { fired: false, reason: null },
        provenance: { firstViolations: [], rewriteViolations: [], composedCount: countComposed(params.first) },
        unresolvedRepos: [],
        normalisedExtras: 0,
      },
    };
  }

  const coverageAfter = scoreSummaryCoverage(joinProjectsText(rewriteOut, params.pool), targets);
  const rewriteViolations = validateProjectsProvenance(rewriteOut, params.pool);
  const rewriteValid = rewriteViolations.length === 0;

  const { kept, keptReason } = decideKeepProjects(coverageBefore.covered, coverageAfter.covered, rewriteValid);
  const output = kept === 'rewrite' ? rewriteOut : params.first;
  return {
    output,
    diag: {
      targets, coverageBefore,
      rewrite: { fired: true, reason: 'coverage-below-targets', coverageAfter, kept, keptReason },
      fallback: { fired: false, reason: null },
      provenance: { firstViolations: [], rewriteViolations, composedCount: countComposed(output) },
      unresolvedRepos: [],
      normalisedExtras: 0,
    },
  };
}
