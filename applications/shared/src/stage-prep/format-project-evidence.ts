/** @format */
import type { ProjectEvidenceInput } from './skill-transfer-types.js';

export interface FormatProjectEvidenceOptions {
  /** Max projects to include (most-documented first). Default 8. */
  readonly maxProjects?: number;
  /** Max stack items listed per project. Default 10. */
  readonly maxStackPerProject?: number;
  /** Max decision titles listed per project. Default 3. */
  readonly maxDecisionsPerProject?: number;
}

/**
 * Render a compact, factual "PROJECT CASE STUDIES" block from a user's documented
 * projects — name, one-line pitch, tech stack, and key architectural decisions —
 * for grounding resume bullets and analysis in real, citeable project work.
 *
 * Pure + deterministic. Returns '' when there are no projects (callers fail-open).
 * Projects are ordered by how much is documented (stack + decisions count) so the
 * richest case studies lead.
 */
export function formatProjectEvidence(
  input: ProjectEvidenceInput,
  opts: FormatProjectEvidenceOptions = {},
): string {
  const maxProjects = opts.maxProjects ?? 8;
  const maxStack = opts.maxStackPerProject ?? 10;
  const maxDecisions = opts.maxDecisionsPerProject ?? 3;

  if (input.projects.length === 0) return '';

  const stackByProject = groupBy(input.stackItems, (s) => s.projectId);
  const decisionsByProject = groupBy(input.decisions, (d) => d.projectId);
  const tagsByProject = groupBy(input.tags, (t) => t.projectId);

  const ranked = [...input.projects].sort((a, b) => documentedScore(b) - documentedScore(a));

  function documentedScore(p: { id: string }): number {
    return (stackByProject.get(p.id)?.length ?? 0) + (decisionsByProject.get(p.id)?.length ?? 0) * 2;
  }

  const lines: string[] = [
    'PROJECT CASE STUDIES — the candidate\'s documented projects (their own work).',
    'Ground achievement bullets in these when the JD skill is demonstrated here; reference the project by name.',
    '',
  ];

  let n = 0;
  for (const p of ranked) {
    if (n >= maxProjects) break;
    n += 1;
    const pitch = firstSentence(p.pitch ?? p.tagline ?? '');
    lines.push(pitch ? `${n}. ${p.name} — ${pitch}` : `${n}. ${p.name}`);

    const stack = (stackByProject.get(p.id) ?? []).map((s) => s.name).filter(Boolean).slice(0, maxStack);
    if (stack.length > 0) lines.push(`   Stack: ${stack.join(', ')}`);

    const decisions = (decisionsByProject.get(p.id) ?? []).map((d) => d.title).filter(Boolean).slice(0, maxDecisions);
    if (decisions.length > 0) lines.push(`   Key decisions: ${decisions.join('; ')}`);

    const tags = (tagsByProject.get(p.id) ?? []).map((t) => t.tag).filter(Boolean).slice(0, 8);
    if (tags.length > 0) lines.push(`   Tags: ${tags.join(', ')}`);
  }

  return lines.join('\n');
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k);
    if (arr) arr.push(item);
    else map.set(k, [item]);
  }
  return map;
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const dot = trimmed.indexOf('. ');
  const sentence = dot === -1 ? trimmed : trimmed.slice(0, dot + 1);
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}
