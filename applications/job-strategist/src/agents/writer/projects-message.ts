/**
 * @format
 * User-message builder for the dedicated projects agent.
 *
 * Assembles the two-lane project pool (curated resume bullets the model may
 * quote, plus repo-current facts it may compose from), the requirement-
 * grouped ATS targets, the fixed composition rules, and -- on a re-write
 * pass -- the previous draft plus the targets it missed.
 */
import type { ProjectPoolEntry } from '../evidence/project-agent-inputs.js';
import type { ExperienceAtsTarget } from '../../ats/gate/experience-ats-targets.js';

export interface ProjectsMessageInput {
  readonly pool: readonly ProjectPoolEntry[];
  readonly atsTargets: readonly ExperienceAtsTarget[];
  readonly targetRole: string;
  readonly rewriteDraft?: string;
  readonly rewriteMissing?: readonly string[];
}

/** One project's two-lane block: curated bullets (quote-only) and
 *  repo-current facts (composable, capped at 2 per project downstream). */
function projectBlock(p: ProjectPoolEntry): string[] {
  const out = [
    '',
    `### ${p.name} -- ${p.pitch}`,
    `Repos: ${p.repoUrls.join(', ')}`,
    'Curated bullets (quote-only, select by id):',
  ];
  for (const b of p.curated) out.push(`[${b.id}] ${b.text}`);
  out.push('Repo-current evidence (compose at most 2 bullets per project, cite ids):');
  for (const f of p.repoCurrent) out.push(`[${f.id}] ${f.skill} -- ${f.sourceCitation}`);
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
 *  contents. Curated bullets take priority; composed bullets are capped,
 *  grounded in the pitch, and stay one entry per project. */
function compositionRulesSection(): string[] {
  return [
    '',
    '## Composition rules',
    '- Use curated bullets first; quote them, do not rewrite them.',
    '- Compose a new bullet from repo-current evidence ONLY for a JD target the curated pool does not already answer.',
    '- Compose at most 2 bullets per project.',
    '- Keep any composed bullet description to 40 words or fewer, grounded in the project pitch -- never invent detail beyond it.',
    '- Emit exactly one entry per project.',
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
