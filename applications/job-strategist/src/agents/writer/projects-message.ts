/**
 * @format
 * User-message builder for the dedicated projects agent.
 *
 * Assembles the two-lane project pool (curated resume bullets the model may
 * quote, plus repo-current facts it may compose from), the requirement-
 * grouped ATS targets, the fixed composition rules, and -- on a re-write
 * pass -- the previous draft plus the targets it missed.
 */
import type { ProjectPoolEntry, RepoCurrentFact } from '../evidence/project-agent-inputs.js';
import type { ExperienceAtsTarget } from '../../ats/gate/experience-ats-targets.js';
import { PROJECTS_MAX_BULLETS_PER_ENTRY } from './projects-provenance.js';
import { OPERATIONS_THEMES } from '../evidence/operations-themes.js';

/** Theme labels (operations-themes.ts) -- a repo-current fact whose `skill`
 *  is one of these came from `gatherOperationsEvidence`, not the JD-wide
 *  matcher, and renders under its own "Operations evidence" sub-heading so
 *  the agent sees the operations angle distinctly (Component 3). */
const OPERATIONS_THEME_LABELS = new Set(OPERATIONS_THEMES.map((t) => t.label));

export interface ProjectsMessageInput {
  readonly pool: readonly ProjectPoolEntry[];
  readonly atsTargets: readonly ExperienceAtsTarget[];
  readonly targetRole: string;
  readonly rewriteDraft?: string;
  readonly rewriteMissing?: readonly string[];
}

/** True when a repo-current fact's `skill` is an operations-theme label --
 *  i.e. it came from `gatherOperationsEvidence`, not the JD-wide matcher. */
function isOperationsFact(f: RepoCurrentFact): boolean {
  return OPERATIONS_THEME_LABELS.has(f.skill);
}

/** One project's two-lane block: curated bullets (quote-only) and
 *  repo-current facts (composable, chosen purely by JD relevance up to the
 *  SAME per-entry bullet cap as curated bullets, PROJECTS_MAX_BULLETS_PER_ENTRY
 *  -- Task 3 lifted the old separate "capped at 2 per project" composed-only
 *  allowance so curated and composed bullets compete for slots on equal
 *  footing rather than composed evidence losing to a stale curated bullet).
 *  Repo-current facts whose skill is an operations-theme label render under
 *  a separate "Operations evidence" sub-heading -- both lanes are still
 *  citable ids in the SAME repo-current pool the model may compose from. */
function projectBlock(p: ProjectPoolEntry): string[] {
  const out = [
    '',
    `### ${p.name} -- ${p.pitch}`,
    `Repos: ${p.repoUrls.join(', ')}`,
    'Curated bullets (quote-only, select by id):',
  ];
  for (const b of p.curated) out.push(`[${b.id}] ${b.text}`);
  const opsFacts = p.repoCurrent.filter(isOperationsFact);
  const otherFacts = p.repoCurrent.filter((f) => !isOperationsFact(f));
  out.push('Repo-current evidence (compose ONLY when a fact beats every curated bullet for JD relevance, cite ids):');
  for (const f of otherFacts) out.push(`[${f.id}] ${f.skill} -- ${f.sourceCitation}`);
  if (opsFacts.length > 0) {
    out.push('Operations evidence (how this system is OPERATED -- compose from these when the JD targets are operations-flavoured, cite ids):');
    for (const f of opsFacts) out.push(`[${f.id}] ${f.skill} -- ${f.sourceCitation}`);
  }
  return out;
}

/** Two-lane project pool -- every project's curated and repo-current lanes,
 *  each entry stamped with the id the model must cite. */
function poolSection(pool: readonly ProjectPoolEntry[]): string[] {
  const out = ['## Documented Projects (two-lane pool)'];
  for (const p of pool) out.push(...projectBlock(p));
  return out;
}

/** ATS targets grouped under their JD requirement -- lets a composite
 *  requirement ("DNS, TCP/IP, SSL/TLS") surface each attainable member together. */
function targetsSection(targets: readonly ExperienceAtsTarget[]): string[] {
  if (targets.length === 0) return [];
  const byReq = new Map<string, ExperienceAtsTarget[]>();
  for (const t of targets) byReq.set(t.requirement, [...(byReq.get(t.requirement) ?? []), t]);
  const out = ['', '## ATS Targets (weave each into a project bullet ONLY where honestly supported)'];
  for (const [req, ts] of byReq) {
    out.push(`Requirement: ${req}`);
    for (const t of ts) out.push(`- ${t.skill} (${t.verdict})`);
  }
  return out;
}

/** Fixed composition rules -- always present, independent of pool/target
 *  contents. Task 3 (JD-ranked lane mix): choose each highlight slot by JD
 *  relevance regardless of lane -- a repo-current fact wins a slot over a
 *  curated bullet when it demonstrates the JD target more directly, up to
 *  the per-entry bullet cap (curated and composed compete on the same
 *  footing, not a separate low composed-only allowance); entries themselves
 *  are ordered most-JD-relevant project first. */
function compositionRulesSection(): string[] {
  return [
    '',
    '## Composition rules',
    '- Choose each highlight slot by JD relevance regardless of lane -- quote curated bullets first, but '
      + 'compose from repo-current facts whenever they beat curated bullets at answering a JD target.',
    `- Up to ${PROJECTS_MAX_BULLETS_PER_ENTRY} bullets per project, any mix of curated and composed.`,
    '- Keep any composed bullet description to 40 words or fewer, grounded in the project pitch -- never invent detail beyond it.',
    '- Emit exactly one entry per project, ordered most-JD-relevant project first.',
    '- When citing a repository, use one of the URLs listed under that project\'s Repos line.',
  ];
}

/** Re-write pass block -- only emitted when there is a previous draft AND
 *  targets it missed. */
function rewriteSection(m: ProjectsMessageInput): string[] {
  if (!m.rewriteDraft || (m.rewriteMissing?.length ?? 0) === 0) return [];
  return [
    '',
    '## Re-write pass (keep the narrative; weave the missing targets only if honestly supported)',
    'Previous draft:',
    m.rewriteDraft,
    'Missing targets to weave if the pool honestly supports them:',
    ...(m.rewriteMissing ?? []).map((t) => `- ${t}`),
  ];
}

/** Focused user message for the projects agent -- two-lane pool,
 *  requirement-grouped ATS targets, fixed composition rules, and the
 *  re-write pass block when applicable. */
export function buildProjectsMessage(m: ProjectsMessageInput): string {
  return [
    `Target role: ${m.targetRole}`,
    ...poolSection(m.pool),
    ...targetsSection(m.atsTargets),
    ...compositionRulesSection(),
    ...rewriteSection(m),
  ].join('\n');
}
