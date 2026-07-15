/**
 * @format
 * Deterministic verb-alignment guard (Task 2): does an experience bullet's
 * LEAD verb overstate what its own cited career lines actually support?
 *
 * WHY: live run 1eda06eb shipped "Owned end-to-end technical resolution..."
 * citing one line saying "Assisted" and another containing "own cases
 * end-to-end" -- under the any-cited-line ceiling that case is COMPLIANT (a
 * cited line genuinely supports the stronger verb). The guard exists for the
 * case where NO cited line supports the stronger verb at all.
 *
 * Deliberately small and bounded -- four ordered tiers, no synonym expansion
 * beyond what `lightStem` (Task 1) already bridges plus a same-token prefix
 * match for the inflections `lightStem` does not strip (past tense "-ed",
 * third-person "-s"): "owned"/"owns" against "own", "assisted" against
 * "assist". An unrecognised lead verb is neutral, never a finding -- this is
 * a guard against an OVERSTATEMENT the lexicon can prove, not a style linter.
 */
import { lightStem } from '../../ats/gate/experience-coverage.js';
import type { IndexedCareerLine } from './experience-provenance.js';
import type { ExperienceAgentOutput } from './experience-schema.js';

/** Tier 1 (helper-level) < tier 2 (troubleshoot-level) < tier 3 (owner-level)
 *  < tier 4 (originator-level). Higher tier claims more seniority/scope. */
export const VERB_TIERS: ReadonlyMap<string, 1 | 2 | 3 | 4> = new Map<string, 1 | 2 | 3 | 4>([
  ['assist', 1], ['support', 1], ['help', 1], ['contribute', 1], ['participate', 1],
  ['troubleshoot', 2], ['diagnose', 2], ['resolve', 2], ['investigate', 2], ['debug', 2],
  ['triage', 2], ['guide', 2], ['analyse', 2], ['analyze', 2], ['audit', 2], ['monitor', 2],
  ['own', 3], ['lead', 3], ['manage', 3], ['drive', 3], ['deliver', 3], ['coordinate', 3], ['run', 3],
  ['architect', 4], ['design', 4], ['establish', 4], ['found', 4], ['invent', 4],
]);

export interface VerbAlignmentFinding {
  readonly role: number;
  readonly bullet: number;
  readonly verb: string;
  readonly tier: number;
  readonly ceiling: number;
}

/** Resolve one word against the lexicon: exact match on its `lightStem`, or
 *  the stemmed word starting with a lexicon verb -- covers the common
 *  inflections `lightStem` itself does not strip ("owned"/"owns" -> "own",
 *  "assisted" -> "assist"; "-ing" is already handled by `lightStem`). */
function tierOf(word: string): { verb: string; tier: number } | null {
  const stemmed = lightStem(word);
  for (const [verb, tier] of VERB_TIERS) {
    if (stemmed === verb || stemmed.startsWith(verb)) return { verb, tier };
  }
  return null;
}

/** First non-adverb TOKEN of the bullet -- whitespace-delimited, punctuation
 *  stripped from each token before the 'ly' adverb check and the lexicon
 *  lookup. An unresolved lead verb (adverb-only bullet, or a first token
 *  outside the lexicon) returns null -- neutral, no finding. */
function leadVerbTier(text: string): { verb: string; tier: number } | null {
  const tokens = text.trim().split(/\s+/);
  for (const raw of tokens) {
    const word = raw.replace(/[^A-Za-z]/g, '');
    if (word.length === 0) continue;
    if (word.toLowerCase().endsWith('ly')) continue;
    return tierOf(word);
  }
  return null;
}

/** Highest lexicon tier appearing ANYWHERE (whole-word, lightStem'd) across
 *  the bullet's cited lines that resolve against `lineById` -- unresolvable
 *  source ids are simply not scanned. Returns 0 (below every tier) when no
 *  resolvable line names any lexicon verb at all: the guard's core case,
 *  where the stronger lead verb has no textual support whatsoever. */
function ceilingFor(sources: readonly string[], lineById: ReadonlyMap<string, IndexedCareerLine>): number {
  let ceiling = 0;
  for (const id of sources) {
    const line = lineById.get(id);
    if (!line) continue;
    const words = line.text.match(/[A-Za-z]+/g) ?? [];
    for (const w of words) {
      const match = tierOf(w);
      if (match && match.tier > ceiling) ceiling = match.tier;
    }
  }
  return ceiling;
}

/**
 * Scan every bullet of `kept` for a lead-verb tier that exceeds the ceiling
 * its OWN cited career lines support. A bullet is skipped entirely (no
 * finding, not even a compliant one) when none of its sources resolve
 * against `lines` -- there is nothing to check the verb against.
 */
export function checkVerbAlignment(
  kept: ExperienceAgentOutput,
  lines: readonly IndexedCareerLine[],
): VerbAlignmentFinding[] {
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const findings: VerbAlignmentFinding[] = [];
  kept.roles.forEach((role, roleIndex) => {
    role.highlights.forEach((bullet, bulletIndex) => {
      const resolved = bullet.sources.filter((s) => lineById.has(s));
      if (resolved.length === 0) return;
      const lead = leadVerbTier(bullet.text);
      if (!lead) return;
      const ceiling = ceilingFor(resolved, lineById);
      if (lead.tier > ceiling) {
        findings.push({ role: roleIndex, bullet: bulletIndex, verb: lead.verb, tier: lead.tier, ceiling });
      }
    });
  });
  return findings;
}
