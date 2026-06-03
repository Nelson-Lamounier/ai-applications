/** @format */
import type {
  ProjectEvidenceInput, SkillCandidate, SkillCandidateSet,
} from './skill-transfer-types.js';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'using',
  'system', 'design', 'experience', 'knowledge', 'strong', 'good', 'via',
]);

/** Lowercase alphanumeric tokens of length >=3, minus stopwords. */
function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/** True when the JD-skill tokens and the label tokens share >=1 token. */
function overlaps(skillTokens: Set<string>, label: string): boolean {
  const lt = tokens(label);
  for (const t of skillTokens) if (lt.has(t)) return true;
  return false;
}

/**
 * Pure, deterministic candidate gatherer. For each JD skill, collect project rows
 * whose label tokens overlap the skill's tokens. Tier by source: component/decision
 * = demonstrated; stack_item/tag = claimed; repo evidence = declared. No match → empty
 * (the caller treats empty as a gap). Precision over recall — a missed match is an
 * honest under-claim, never an invented one.
 */
export function joinSkillCandidates(
  jdSkills: readonly string[],
  input: ProjectEvidenceInput,
): SkillCandidateSet[] {
  const projName = new Map(input.projects.map(p => [p.id, p.name]));
  const name = (pid: string): string => projName.get(pid) ?? '';

  return jdSkills.map((jdSkill) => {
    const st = tokens(jdSkill);
    const candidates: SkillCandidate[] = [];
    if (st.size === 0) return { jdSkill, candidates };

    for (const c of input.components) {
      if (overlaps(st, c.name)) candidates.push({ projectId: c.projectId, projectName: name(c.projectId), source: 'component', tier: 'demonstrated', id: c.id, label: c.name });
    }
    for (const d of input.decisions) {
      if (overlaps(st, d.title) || (d.decision != null && overlaps(st, d.decision)))
        candidates.push({ projectId: d.projectId, projectName: name(d.projectId), source: 'decision', tier: 'demonstrated', id: d.id, label: d.title });
    }
    for (const s of input.stackItems) {
      if (overlaps(st, s.name)) candidates.push({ projectId: s.projectId, projectName: name(s.projectId), source: 'stack_item', tier: 'claimed', id: s.id, label: s.name });
    }
    for (const t of input.tags) {
      if (overlaps(st, t.tag)) candidates.push({ projectId: t.projectId, projectName: name(t.projectId), source: 'tag', tier: 'claimed', id: `${t.projectId}:${t.tag}`, label: t.tag });
    }
    for (const e of input.repoEvidence) {
      if (overlaps(st, e.rawName)) candidates.push({ projectId: e.projectId, projectName: name(e.projectId), source: e.source, tier: 'declared', id: e.id, label: e.rawName, fileLine: e.fileLine });
    }
    return { jdSkill, candidates };
  });
}
