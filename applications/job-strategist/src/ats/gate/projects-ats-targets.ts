/** @format */
import type { SkillEvidenceEntry } from '@bedrock/shared';
import type { ExperienceAtsTarget } from './experience-ats-targets.js';

/**
 * Split of the experience-lane ATS targets into the subset the PROJECTS lane
 * can honestly cover, plus the targets routed away (career-only evidence).
 * `excluded` carries the skill names for diagnostics -- the run-pipeline
 * caller logs them so a mis-routed target is visible in Loki, the same way
 * `unresolvedRepos` surfaces citation failures.
 */
export interface ProjectsAtsTargetSplit {
  readonly targets: ExperienceAtsTarget[];
  readonly excluded: string[];
}

/**
 * Filter the experience-lane ATS targets down to those the projects lane can
 * structurally cover -- targets whose Skill Evidence Ledger entry cites repo
 * or documented-project evidence (`sourceLanes` includes 'repo' or 'project').
 *
 * WHY: the projects agent previously received the experience lane's targets
 * verbatim, including skills whose only evidence is the candidate's career
 * history (e.g. "Customer-facing support", "Communication" on a support-role
 * JD). No repository can prove those, so they were guaranteed "missing"
 * verdicts: they fired the coverage re-write (which cannot gain -- the pool
 * has nothing to cite), polluted `coverageBefore/After` diagnostics, and
 * showed up as career entries under `unresolvedRepos` when the model tried to
 * anchor them anyway (live Salesforce TSE run, 2026-07-24: 1/6 covered with
 * 5 structurally uncoverable targets). Career-only targets belong to the
 * experience lane alone.
 *
 * Matching is by exact tool name -- `selectExperienceAtsTargets` builds each
 * target's `skill` from a ledger entry's `tool` verbatim, so the lookup can
 * never miss for targets built from this ledger.
 *
 * FAIL-OPEN for provenance-less rows: a target whose ledger entry predates
 * source-lane provenance (`sourceLanes` absent) or has an empty lane list is
 * KEPT -- the pre-split behaviour -- so legacy runs and partial assemblies
 * never silently starve the projects lane of targets.
 */
export function selectProjectsAtsTargets(
  targets: readonly ExperienceAtsTarget[],
  ledger: readonly SkillEvidenceEntry[],
): ProjectsAtsTargetSplit {
  const lanesByTool = new Map(ledger.map((e) => [e.tool.toLowerCase(), e.sourceLanes]));
  const kept: ExperienceAtsTarget[] = [];
  const excluded: string[] = [];
  for (const t of targets) {
    const lanes = lanesByTool.get(t.skill.toLowerCase());
    const careerOnly =
      lanes !== undefined && lanes.length > 0 && !lanes.includes('repo') && !lanes.includes('project');
    if (careerOnly) excluded.push(t.skill);
    else kept.push(t);
  }
  return { targets: kept, excluded };
}
