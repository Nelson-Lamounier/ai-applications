/** @format */
import type { ProjectEvidenceInput } from './skill-transfer-types.js';

export interface FormatProjectEvidenceOptions {
  /** Max projects to include (most-documented first). Default 8. */
  readonly maxProjects?: number;
  /** Max stack items listed per project. Default 12. */
  readonly maxStackPerProject?: number;
  /** Max decisions listed per project. Default 5. */
  readonly maxDecisionsPerProject?: number;
  /** Max achievement highlights listed per project. Default 5. */
  readonly maxHighlightsPerProject?: number;
  /** Max challenges (problem/solution) listed per project. Default 4. */
  readonly maxChallengesPerProject?: number;
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
type Decision  = ProjectEvidenceInput['decisions'][number];
type Highlight = ProjectEvidenceInput['highlights'][number];
type Challenge = ProjectEvidenceInput['challenges'][number];

interface Grouped {
  readonly stack:      Map<string, ProjectEvidenceInput['stackItems'][number][]>;
  readonly decisions:  Map<string, Decision[]>;
  readonly highlights: Map<string, Highlight[]>;
  readonly challenges: Map<string, Challenge[]>;
  readonly tags:       Map<string, ProjectEvidenceInput['tags'][number][]>;
}

interface Caps {
  readonly maxProjects: number;
  readonly maxStack: number;
  readonly maxDecisions: number;
  readonly maxHighlights: number;
  readonly maxChallenges: number;
}

const renderDecision  = (d: Decision):  string => (d.decision  ? `${d.title}: ${clip(d.decision)}`     : d.title);
const renderHighlight = (h: Highlight): string => (h.description ? `${h.title} — ${clip(h.description)}` : h.title);
const renderChallenge = (c: Challenge): string => (c.solution  ? `${c.problem} → ${clip(c.solution)}`   : c.problem);

export function formatProjectEvidence(
  input: ProjectEvidenceInput,
  opts: FormatProjectEvidenceOptions = {},
): string {
  if (input.projects.length === 0) return '';

  const caps: Caps = {
    maxProjects:   opts.maxProjects ?? 8,
    maxStack:      opts.maxStackPerProject ?? 12,
    maxDecisions:  opts.maxDecisionsPerProject ?? 5,
    maxHighlights: opts.maxHighlightsPerProject ?? 5,
    maxChallenges: opts.maxChallengesPerProject ?? 4,
  };
  const g: Grouped = {
    stack:      groupBy(input.stackItems, (s) => s.projectId),
    decisions:  groupBy(input.decisions, (d) => d.projectId),
    highlights: groupBy(input.highlights, (h) => h.projectId),
    challenges: groupBy(input.challenges, (c) => c.projectId),
    tags:       groupBy(input.tags, (t) => t.projectId),
  };

  const ranked = [...input.projects].sort((a, b) => documentedScore(g, b) - documentedScore(g, a));

  const lines: string[] = [
    'PROJECT CASE STUDIES — the candidate\'s documented projects (their own work).',
    'Ground achievement bullets in these when the JD skill is demonstrated here; reference the project by name.',
    '',
  ];
  ranked.slice(0, caps.maxProjects).forEach((p, i) => renderProject(lines, p, i, g, caps));
  return lines.join('\n');
}

/** Rank by how much resume-grade signal each project carries; highlights and
 *  decisions weigh most because they're the citeable achievement content. */
function documentedScore(g: Grouped, p: { id: string }): number {
  return (g.stack.get(p.id)?.length ?? 0)
    + (g.decisions.get(p.id)?.length ?? 0) * 2
    + (g.highlights.get(p.id)?.length ?? 0) * 2
    + (g.challenges.get(p.id)?.length ?? 0);
}

/** Append one project's block (heading + stack/decisions/highlights/challenges/tags) to `lines`. */
function renderProject(
  lines: string[],
  p: ProjectEvidenceInput['projects'][number],
  index: number,
  g: Grouped,
  caps: Caps,
): void {
  const pitch = pitchOf(p);
  lines.push(pitch ? `${index + 1}. ${p.name} — ${pitch}` : `${index + 1}. ${p.name}`);

  const stack = at(g.stack, p.id).map((s) => s.name).filter(Boolean).slice(0, caps.maxStack);
  if (stack.length > 0) lines.push(`   Stack: ${stack.join(', ')}`);

  const decisions = at(g.decisions, p.id).filter((d) => Boolean(d.title)).slice(0, caps.maxDecisions);
  pushSection(lines, 'Key design decisions:', decisions, renderDecision);

  // Highlights = the richest achievement signal. Dedupe by normalized title —
  // case-study regeneration currently accumulates rows, so near-dupes occur.
  const highlights = dedupeBy(
    at(g.highlights, p.id).filter((h) => Boolean(h.title)), (h) => normalize(h.title),
  ).slice(0, caps.maxHighlights);
  pushSection(lines, 'Highlights:', highlights, renderHighlight);

  const challenges = dedupeBy(
    at(g.challenges, p.id).filter((c) => Boolean(c.problem)), (c) => normalize(c.problem),
  ).slice(0, caps.maxChallenges);
  pushSection(lines, 'Challenges solved:', challenges, renderChallenge);

  const tags = at(g.tags, p.id).map((t) => t.tag).filter(Boolean).slice(0, 8);
  if (tags.length > 0) lines.push(`   Tags: ${tags.join(', ')}`);
}

/** Map lookup that always yields an array (never undefined). */
function at<T>(m: Map<string, T[]>, id: string): T[] {
  return m.get(id) ?? [];
}

function pitchOf(p: { pitch?: string | null; tagline?: string | null }): string {
  return firstSentence(p.pitch ?? p.tagline ?? '');
}

/** Append a labelled bullet section to `lines` when it has entries (no-op if empty). */
function pushSection<T>(lines: string[], label: string, entries: readonly T[], render: (t: T) => string): void {
  if (entries.length === 0) return;
  lines.push(`   ${label}`);
  for (const e of entries) lines.push(`   - ${render(e)}`);
}

/** First key wins; later items with a duplicate key are dropped (order preserved). */
function dedupeBy<T>(items: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Trim a single narrative field so one verbose row can't dominate the block. */
function clip(text: string): string {
  const t = text.trim();
  return t.length > 220 ? `${t.slice(0, 217)}...` : t;
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
