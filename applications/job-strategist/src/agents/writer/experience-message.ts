/**
 * @format
 * User-message builder for the dedicated experience agent.
 *
 * Assembles the indexed career lines (accounting contract -- every line MUST
 * be cited in a bullet or dropped with a reason), the requirement-grouped ATS
 * targets, the verified-match evidence, the grounded metrics, the code stack,
 * and -- on a re-write pass -- the previous draft plus the targets it missed.
 */
import type { StrategistResearchResult } from '@bedrock/shared';
import type { ExperienceAtsTarget } from '../../ats/gate/experience-ats-targets.js';
import type { IndexedCareerLine, RosterEntry } from './experience-provenance.js';

export interface ExperienceMessageInput {
  readonly research: StrategistResearchResult;
  readonly roster: readonly RosterEntry[];
  readonly careerLines: readonly IndexedCareerLine[];
  readonly atsTargets: readonly ExperienceAtsTarget[];
  /** composeMetricsBlock output ('' when none). */
  readonly groundedMetrics: string;
  /** codeStackContext block ('' when none). */
  readonly codeStack: string;
  readonly rewriteDraft?: string;
  readonly rewriteMissing?: readonly string[];
}

/** Indexed career lines, grouped by role in roster order -- the accounting
 *  contract the model must satisfy (every line cited or dropped with a reason). */
function careerSection(roster: readonly RosterEntry[], lines: readonly IndexedCareerLine[]): string[] {
  const out = [
    '## Career History (line-by-line, indexed -- every line MUST be accounted for)',
    'Rewrite, merge, or reorder these lines against the JD; drop a line ONLY with a reason in accounting.dropped.',
    'Never copy verbatim when JD vocabulary honestly applies; never write a bullet no line supports.',
  ];
  roster.forEach((r, i) => {
    out.push('', `### ${r.title} -- ${r.company} (${r.period})`);
    for (const l of lines.filter((x) => x.roleIndex === i)) out.push(`[${l.id}] ${l.text}`);
  });
  return out;
}

/** ATS targets grouped under their JD requirement -- lets a composite
 *  requirement ("DNS, TCP/IP, SSL/TLS") surface each attainable member together. */
function targetsSection(targets: readonly ExperienceAtsTarget[]): string[] {
  if (targets.length === 0) return [];
  const byReq = new Map<string, ExperienceAtsTarget[]>();
  for (const t of targets) byReq.set(t.requirement, [...(byReq.get(t.requirement) ?? []), t]);
  const out = ['', '## ATS Targets (weave each into a bullet ONLY where a cited line honestly supports it)'];
  for (const [req, ts] of byReq) {
    out.push(`Requirement: ${req}`);
    for (const t of ts) out.push(`- ${t.skill} (${t.verdict})`);
  }
  return out;
}

/** Verified-match evidence, grounded metrics, and code-stack blocks -- the
 *  material the model may honestly draw on when rewriting a bullet. */
function evidenceSections(m: ExperienceMessageInput): string[] {
  const out: string[] = ['', '## Verified Matches (evidence for rewrites -- cite honestly)'];
  for (const v of m.research.verifiedMatches) {
    out.push(`- ${v.skill} (${v.depth}, ${v.recency}) [${v.sourceCitation}]`);
  }
  if (m.groundedMetrics.trim()) {
    out.push('', '## Grounded Metrics (the ONLY permitted numbers -- verbatim or not at all)', m.groundedMetrics);
  }
  if (m.codeStack.trim()) {
    out.push('', '## Code Stack (present current technology as current)', m.codeStack);
  }
  return out;
}

/** Re-write pass block -- only emitted when there is a previous draft AND
 *  targets it missed. */
function rewriteSection(m: ExperienceMessageInput): string[] {
  if (!m.rewriteDraft || (m.rewriteMissing?.length ?? 0) === 0) return [];
  return [
    '',
    '## Re-write pass (keep the narrative; weave the missing targets only if honestly supported)',
    'Previous draft:',
    m.rewriteDraft,
    'Missing targets to weave if a cited line supports them:',
    ...(m.rewriteMissing ?? []).map((t) => `- ${t}`),
  ];
}

/** Focused user message for the experience agent -- indexed career lines,
 *  requirement-grouped ATS targets, evidence, metrics, and code stack. */
export function buildExperienceMessage(m: ExperienceMessageInput): string {
  return [
    `Target role: ${m.research.targetRole}`,
    ...careerSection(m.roster, m.careerLines),
    ...targetsSection(m.atsTargets),
    ...evidenceSections(m),
    ...rewriteSection(m),
  ].join('\n');
}
