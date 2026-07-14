/** @format */
import type { CareerEntry } from '../evidence/career-history.js';
import type { ExperienceAgentOutput } from './experience-schema.js';

export interface IndexedCareerLine {
  readonly id: string;        // c{roleIndex}.h{lineIndex}
  readonly roleIndex: number;
  readonly text: string;
}
export interface RosterEntry { readonly company: string; readonly title: string; readonly period: string; }

export function indexCareerLines(entries: readonly CareerEntry[]): IndexedCareerLine[] {
  return entries.flatMap((e, i) => e.highlights.map((text, j) => ({ id: `c${i}.h${j}`, roleIndex: i, text })));
}

export function rosterFromCareer(entries: readonly CareerEntry[]): RosterEntry[] {
  return entries.map((e) => ({ company: e.company, title: e.title, period: e.period }));
}

const MAX_BULLETS = 5;

/**
 * Deterministic provenance rules (spec section experience-provenance):
 * (a) every bullet cites >=1 career line OF ITS OWN role (metric ids `m*` are
 *     secondary -- they never satisfy the requirement alone);
 * (b) every input career line appears in some bullet's sources or in
 *     accounting.dropped;
 * (c) company/title/period byte-identical to the roster, same order and count;
 * (d) 1..5 bullets per role with >=1 career line; min 2 when the role has >=2
 *     lines; roles with 0 lines may have 0 bullets.
 * Returns machine-readable violation tokens; empty array = valid.
 */
export function validateExperienceProvenance(
  out: ExperienceAgentOutput,
  roster: readonly RosterEntry[],
  lines: readonly IndexedCareerLine[],
): string[] {
  const violations: string[] = [];
  const lineById = new Map(lines.map((l) => [l.id, l]));
  if (out.roles.length !== roster.length) violations.push(`roster_count:${out.roles.length}`);

  const cited = new Set<string>();
  out.roles.forEach((role, i) => {
    const r = roster[i];
    if (r && (role.company !== r.company || role.title !== r.title || role.period !== r.period)) {
      violations.push(`roster_drift:${i}`);
    }
    const roleLineCount = lines.filter((l) => l.roleIndex === i).length;
    const min = Math.min(2, roleLineCount);
    if (role.highlights.length > MAX_BULLETS || role.highlights.length < min) {
      violations.push(`bullet_count:${role.company}:${role.highlights.length}`);
    }
    role.highlights.forEach((b, bi) => {
      const careerSources = b.sources.filter((s) => lineById.has(s));
      if (careerSources.length === 0) violations.push(`uncited_bullet:${role.company}:${bi}`);
      for (const s of careerSources) {
        cited.add(s);
        if (lineById.get(s)!.roleIndex !== i) violations.push(`cross_role_citation:${role.company}:${s}`);
      }
    });
  });

  const dropped = new Set(out.accounting.dropped.map((d) => d.line));
  for (const l of lines) {
    if (!cited.has(l.id) && !dropped.has(l.id)) violations.push(`unaccounted_line:${l.id}`);
  }
  return violations;
}

/** The SYSTEM assembles the final section -- the model never emits final strings unchecked. */
export function assembleExperience(
  out: ExperienceAgentOutput,
): Array<{ company: string; title: string; period: string; highlights: string[] }> {
  return out.roles.map((r) => ({
    company: r.company, title: r.title, period: r.period,
    highlights: r.highlights.map((b) => b.text),
  }));
}
