/** @format */
import type { ExperienceAtsTarget } from '../../ats/gate/experience-ats-targets.js';
import { scoreExperienceCoverage, type ScorableBullet } from '../../ats/gate/experience-coverage.js';
import type { SummaryCoverage } from '../../ats/gate/summary-coverage.js';
import type { ProjectPoolEntry } from '../evidence/project-agent-inputs.js';
import { stampProjectDescription } from './projects-description.js';
import { assembleProjects, PROJECTS_MAX_BULLETS_PER_ENTRY, validateProjectsProvenance } from './projects-provenance.js';
import { isCurated, type ProjectsAgentOutput } from './projects-schema.js';
import { checkComposedBulletStyle, type StyleFinding } from './projects-style.js';

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
 *  normaliseProjectsAgentOutput, a fact this function has no visibility into.
 *
 *  `themes` is likewise NOT populated by this module -- it always sets it to
 *  the empty default (`{ activated: [], factCounts: {} }`). It is injected by
 *  the run-pipeline caller from the operations-evidence gather step's result
 *  (activateThemes's theme keys + gatherOperationsEvidence's factCounts),
 *  which runs well before this module (during pool construction, not during
 *  agent resolution) -- same injection pattern as unresolvedRepos. */
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
  readonly themes: { readonly activated: readonly string[]; readonly factCounts: Record<string, number> };
  readonly style: ProjectsStyleDiagnostics;
}

/** Composed-bullet narrative style diagnostics (Component 3/4, see
 *  `projects-style.ts`) -- persisted alongside the rest of
 *  `ProjectsAgentDiagnostics` (`pipeline_runs.metadata.analysis.projectsAgent.style`).
 *  `composedFindings` counts style findings across the KEPT output's composed
 *  (model-authored) highlights ONLY -- these are the findings that were, or
 *  could have been, routed into the ATS re-write for repair (see
 *  `resolveProjectsAts` below). `curatedAdvisories` counts findings across the
 *  KEPT output's curated (quote-only) highlights, resolved to their VERBATIM
 *  pool text -- curated bullets are NEVER repaired at resume time (byte-
 *  fidelity contract, `projects-provenance.ts`), so these are visibility-only,
 *  for the future multi-angle case-study loop to act on. `kinds` is a
 *  bounded (at most three keys -- `StyleFindingKind` is a fixed union)
 *  tally of finding kind -> count across BOTH lanes, carried purely so the
 *  Loki `projects_style_findings` event (projects-agent-diagnostics.ts) can
 *  report "kinds + counts" without re-linting already-assembled text. */
export interface ProjectsStyleDiagnostics {
  readonly composedFindings: number;
  readonly curatedAdvisories: number;
  readonly kinds: Readonly<Record<string, number>>;
}

/** No-composed-content default for `ProjectsAgentDiagnostics.style` -- the
 *  deterministic (no-LLM) fallback path in `fillResumeProjects` (run-pipeline.ts)
 *  never composes and does not re-lint the curated bullets it selects, so it
 *  always sets `style` to this literal (mirrors `EMPTY_OPERATIONS_THEMES_DIAG`'s
 *  role for `themes` on the same fallback path). */
export const EMPTY_PROJECTS_STYLE_DIAG: ProjectsStyleDiagnostics = { composedFindings: 0, curatedAdvisories: 0, kinds: {} };

/** Composed-bullet style findings for one output, flattened across every
 *  entry -- curated highlights are excluded (curated bullets are exempt from
 *  the guard; see `projects-style.ts`'s module doc). This is the SAME set fed
 *  into the ATS re-write's style-repair context below AND, via
 *  `projectsStyleDiagnostics`, counted into `style.composedFindings` on
 *  whichever output ships. */
function composedStyleFindings(out: ProjectsAgentOutput): StyleFinding[] {
  return out.entries.flatMap((e) => e.highlights.flatMap((h) => (isCurated(h) ? [] : checkComposedBulletStyle(h.text))));
}

/** Curated-bullet style findings for one output, resolved to the pool's
 *  VERBATIM text -- advisory-only, NEVER repaired (curated bullets are
 *  byte-fidelity quotes, `projects-provenance.ts`). Feeds
 *  `style.curatedAdvisories` only. */
function curatedStyleFindings(out: ProjectsAgentOutput, pool: readonly ProjectPoolEntry[]): StyleFinding[] {
  const poolByName = new Map(pool.map((p) => [p.name, p]));
  return out.entries.flatMap((entry) => {
    const curatedById = new Map((poolByName.get(entry.name)?.curated ?? []).map((c) => [c.id, c.text]));
    return entry.highlights.flatMap((h) => (isCurated(h) ? checkComposedBulletStyle(curatedById.get(h.bulletId) ?? '') : []));
  });
}

/** Kind -> count tally over one combined findings list -- at most three keys
 *  (`StyleFindingKind` is a fixed three-member union), so this is bounded
 *  regardless of how many findings fed it. */
function tallyKinds(findings: readonly StyleFinding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.kind] = (out[f.kind] ?? 0) + 1;
  return out;
}

/** `ProjectsAgentDiagnostics.style` for whichever output ships (the first
 *  draft, or the kept re-write) -- see the field's own doc comment above. */
export function projectsStyleDiagnostics(out: ProjectsAgentOutput, pool: readonly ProjectPoolEntry[]): ProjectsStyleDiagnostics {
  const composed = composedStyleFindings(out);
  const curated = curatedStyleFindings(out, pool);
  return {
    composedFindings: composed.length,
    curatedAdvisories: curated.length,
    kinds: tallyKinds([...composed, ...curated]),
  };
}

/** Empty-gather default for `ProjectsAgentDiagnostics.themes` -- see that
 *  field's doc comment. Exported so both this module's placeholder diag
 *  constructions and the run-pipeline caller's fallback path share one
 *  literal. */
export const EMPTY_OPERATIONS_THEMES_DIAG: ProjectsAgentDiagnostics['themes'] = { activated: [], factCounts: {} };

/** Sum `normalisedExtras` across the first draft and any re-write call --
 *  the glue `fillResumeProjects` (run-pipeline.ts) uses to fill in the
 *  `normalisedExtras` this module always sets to `0` (see the doc comment
 *  above). Extracted as a pure, exported helper because `fillResumeProjects`
 *  itself is not directly unit-testable in isolation (it drives async agent
 *  calls through a DB-backed `StrategistPipelineContext`) -- this is the
 *  tested seam for the "first + rewrite" summation it depends on. */
export function sumProjectsNormalisedExtras(first: number, rewrite: number): number {
  return first + rewrite;
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

/** One output's highlights (both lanes), resolved to `{text, sources}` --
 *  curated highlights resolve to the pool's VERBATIM text with the cited
 *  `bulletId` as their sole source; composed highlights use their own text
 *  and sources. Descriptions are deliberately excluded: Task 2 locked them to
 *  the `stampProjectDescription` pitch stamp, so they carry no JD-tailored
 *  content -- only highlights are scored against ATS targets. */
function projectsScorableBullets(out: ProjectsAgentOutput, pool: readonly ProjectPoolEntry[]): ScorableBullet[] {
  const poolByName = new Map(pool.map((p) => [p.name, p]));
  return out.entries.flatMap((entry) => {
    const curatedById = new Map((poolByName.get(entry.name)?.curated ?? []).map((c) => [c.id, c.text]));
    return entry.highlights.map((h) =>
      isCurated(h)
        ? { text: curatedById.get(h.bulletId) ?? '', sources: [h.bulletId] }
        : { text: h.text, sources: h.sources },
    );
  });
}

/**
 * Term-tolerant coverage of the projects section's HIGHLIGHTS against its ATS
 * targets -- Task 3 term-rule v2. Delegates entirely to the experience lane's
 * `scoreExperienceCoverage` (same `experienceTermMatch` semantics, same
 * `{targets, covered, missing}` shape) instead of the old exact-adjacent-
 * phrase `scoreSummaryCoverage`, which under-credited a bullet that
 * demonstrated a target's SKILL without its literal wording (the live
 * MongoDB TSE run scored 0/6 despite genuinely relevant bullets). Diagnostics
 * and persistence are untouched -- only the predicate deciding "covered"
 * changed, not the shape callers read.
 *
 * NOTE: `scoreExperienceCoverage`'s anchor-credit branch (`target.anchors`,
 * populated with career-line ids like `c{i}.h{j}`) is structurally inert
 * here -- projects bullets only ever cite `p{i}.b{j}` (curated) or `p{i}.r{k}`
 * (repo-current) ids, a disjoint namespace from career anchors, so that
 * branch can never match and every projects target is decided purely by
 * `experienceTermMatch`. Not a bug to fix -- just why anchors never fire
 * on this call path.
 */
export function scoreProjectsCoverage(
  out: ProjectsAgentOutput,
  pool: readonly ProjectPoolEntry[],
  targets: readonly ExperienceAtsTarget[],
): SummaryCoverage {
  return scoreExperienceCoverage(projectsScorableBullets(out, pool), targets);
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

/** Count of `targets` any of `texts` term-matches (`experienceTermMatch`) --
 *  the shared metric behind both the per-bullet ranking below and the
 *  entry-ordering metric in `deterministicProjects`. Sources are always `[]`:
 *  the deterministic fallback has no anchor data to cite (it never runs the
 *  agent), so coverage here is purely text-driven, same as the pre-Task-3
 *  `scoreSummaryCoverage` call it replaces. */
function countTermMatches(texts: readonly string[], targets: readonly ExperienceAtsTarget[]): number {
  return scoreExperienceCoverage(texts.map((text) => ({ text, sources: [] })), targets).covered;
}

/** Leading diagnostic verb -- a curated bullet opening with one of these
 *  narrates troubleshooting work (symptom -> root cause -> resolution), the
 *  shape a support-lean JD hires for. Used ONLY as a ranking tie-break inside
 *  `rankProjectEntry` when `supportLean` is set -- never a filter, so a
 *  builder bullet that covers more targets still wins its slot. */
const DIAGNOSTIC_LEAD_VERB =
  /^(fixed|diagnosed|debugged|resolved|investigated|traced|root-caused|triaged|remediated|restored|corrected|patched)\b/i;

/** 1 when the bullet leads with a diagnostic verb, else 0 -- numeric so it
 *  slots directly into the sort comparator. */
function diagnosticLead(text: string): number {
  return DIAGNOSTIC_LEAD_VERB.test(text.trim()) ? 1 : 0;
}

/** Per-pool-entry deterministic fallback: rank curated bullets by ATS-target
 *  TERM-MATCH coverage (Task 3 term-rule v2 -- `experienceTermMatch`, not the
 *  old exact-adjacent-phrase `scoreSummaryCoverage`), stable on ties (i.e.
 *  original order), take at most `PROJECTS_MAX_BULLETS_PER_ENTRY`. On a
 *  support-lean JD (`supportLean`), equal-coverage ties break towards bullets
 *  leading with a diagnostic verb (see `DIAGNOSTIC_LEAD_VERB`) before falling
 *  back to original order.
 *  Description is the deterministic pitch stamp (`stampProjectDescription`,
 *  projects-description.ts, given both `pitch` and `tagline` -- the G3
 *  empty-pitch fallback) -- the SAME function the agent-success path uses
 *  in run-pipeline.ts, so no path can ship a differently-shaped description
 *  (this replaced an older ad hoc 40-word raw pitch trim); github is the
 *  project's first known repo URL. Projects with no curated bullets are skipped
 *  entirely (there is nothing safe to say about them without the model).
 *  `coveredTargets` is the entry-ordering metric: how many targets the
 *  SELECTED (post-slice) highlights term-match -- `deterministicProjects`
 *  strips it before the fallback output ships. */
function rankProjectEntry(
  entry: ProjectPoolEntry,
  targets: readonly ExperienceAtsTarget[],
  supportLean = false,
): { name: string; description: string; github?: string; highlights: string[]; coveredTargets: number } {
  const ranked = entry.curated
    .map((bullet, idx) => ({ bullet, idx, covered: countTermMatches([bullet.text], targets) }))
    .sort(
      (a, b) =>
        b.covered - a.covered ||
        (supportLean ? diagnosticLead(b.bullet.text) - diagnosticLead(a.bullet.text) : 0) ||
        a.idx - b.idx,
    );
  const highlights = ranked.slice(0, PROJECTS_MAX_BULLETS_PER_ENTRY).map((r) => r.bullet.text);
  const coveredTargets = countTermMatches(highlights, targets);

  const description = stampProjectDescription(entry.pitch, entry.tagline);

  const github = entry.repoUrls[0];
  return { name: entry.name, description, ...(github !== undefined ? { github } : {}), highlights, coveredTargets };
}

/** Deterministic (no-LLM) fallback for the projects section: used when the first
 *  ATS-aware draft fails validation and must not reach the model again. Only
 *  pool entries with a non-empty curated lane are emitted -- there is no safe
 *  deterministic content for a project with nothing curated yet.
 *
 *  Task 3 (JD-ranked lane mix): entries are ordered DESC by `coveredTargets`
 *  (targets its selected highlights term-match), ties keeping the pool's
 *  original order (stable sort, index tie-break) -- the fallback equivalent
 *  of "order entries most-JD-relevant first" (the agent-path rule in
 *  projects-message.ts / the persona). Fixes the MongoDB TSE live-run
 *  regression where a near-zero-signal project shipped ahead of one with
 *  strong, unused JD evidence. */
export function deterministicProjects(
  pool: readonly ProjectPoolEntry[],
  targets: readonly ExperienceAtsTarget[],
  supportLean = false,
): Array<{ name: string; description: string; github?: string; highlights: string[] }> {
  return pool
    .filter((p) => p.curated.length > 0)
    .map((p, idx) => ({ idx, entry: rankProjectEntry(p, targets, supportLean) }))
    .sort((a, b) => b.entry.coveredTargets - a.entry.coveredTargets || a.idx - b.idx)
    .map(({ entry }) => {
      const { coveredTargets: _coveredTargets, ...rest } = entry;
      return rest;
    });
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
 *
 * STYLE REPAIR ROUTING (Component 3, generalised from the experience lane's
 * jd-echo pattern but SIMPLER -- there is no second, style-only rewrite
 * trigger here): `params.first`'s composed-bullet style findings
 * (`composedStyleFindings`, generic patterns only -- `projects-style.ts`) are
 * computed once and handed to `params.rewrite` as a THIRD argument ONLY when
 * the ATS re-write is about to fire anyway (the existing coverage-below-
 * targets trigger) -- the caller renders them into the SAME rewrite call's
 * message as extra repair context. If coverage is already met, the re-write
 * never fires and any style findings on `params.first` stay advisory only
 * (see `diag.style`) -- a style violation alone NEVER triggers a new LLM
 * call. Whichever output ships (first or rewrite) is re-linted via
 * `projectsStyleDiagnostics` for `diag.style`, so an invalid or no-gain
 * re-write's style findings are reported against `params.first` again, and a
 * kept re-write's `diag.style` reflects whatever style debt IT still carries
 * (the repair is best-effort, not a second guard gate -- still-dirty output
 * ships with advisory violations, never a fallback).
 */
export async function resolveProjectsAts(params: {
  readonly first: ProjectsAgentOutput;
  readonly pool: readonly ProjectPoolEntry[];
  readonly targets: readonly ExperienceAtsTarget[];
  readonly rewrite: (draftText: string, missing: string[], styleFindings: readonly StyleFinding[]) => Promise<ProjectsAgentOutput>;
}): Promise<{ output: ProjectsAgentOutput; diag: ProjectsAgentDiagnostics }> {
  const targets = [...params.targets];
  const coverageBefore = scoreProjectsCoverage(params.first, params.pool, targets);

  const noRewrite = (reason: string): { output: ProjectsAgentOutput; diag: ProjectsAgentDiagnostics } => ({
    output: params.first,
    diag: {
      targets, coverageBefore,
      rewrite: { fired: false, reason, coverageAfter: null, kept: null, keptReason: null },
      fallback: { fired: false, reason: null },
      provenance: { firstViolations: [], rewriteViolations: [], composedCount: countComposed(params.first) },
      unresolvedRepos: [],
      normalisedExtras: 0,
      themes: EMPTY_OPERATIONS_THEMES_DIAG,
      style: projectsStyleDiagnostics(params.first, params.pool),
    },
  });

  if (targets.length === 0) return noRewrite('no-targets');
  if (coverageBefore.covered >= targets.length) return noRewrite('coverage-met');

  const draftText = buildDraftText(params.first, params.pool);
  const firstStyleFindings = composedStyleFindings(params.first);
  let rewriteOut: ProjectsAgentOutput;
  try {
    rewriteOut = await params.rewrite(draftText, coverageBefore.missing, firstStyleFindings);
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
        themes: EMPTY_OPERATIONS_THEMES_DIAG,
        style: projectsStyleDiagnostics(params.first, params.pool),
      },
    };
  }

  const coverageAfter = scoreProjectsCoverage(rewriteOut, params.pool, targets);
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
      themes: EMPTY_OPERATIONS_THEMES_DIAG,
      style: projectsStyleDiagnostics(output, params.pool),
    },
  };
}
