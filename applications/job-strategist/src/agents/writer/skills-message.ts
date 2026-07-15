/**
 * @format
 * User-message builder for the dedicated skills agent.
 *
 * Assembles the JD's required/preferred skill list, the verified and partial
 * match evidence (with depth/recency), and the JD's technology inventory --
 * the material the model may honestly draw skill names from. Deliberately
 * carries NO education content; the reconciler owns education.
 */
import type { JdSignal, PartialMatch, VerifiedMatch } from '@bedrock/shared';

export interface SkillsMessageInput {
  readonly jd: JdSignal;
  readonly verifiedMatches: readonly VerifiedMatch[];
  readonly partialMatches: readonly PartialMatch[];
}

/** JD required/preferred skills -- the selection order the model must follow. */
function requirementsSection(jd: JdSignal): string[] {
  const out = ['', '## JD Skill Requirements (select required -> preferred -> supporting)'];
  if (jd.requiredSkills.length > 0) out.push('Required:', ...jd.requiredSkills.map((s) => `- ${s}`));
  if (jd.preferredSkills.length > 0) out.push('Preferred:', ...jd.preferredSkills.map((s) => `- ${s}`));
  return out;
}

/** Verified + partial ledger evidence -- the ONLY skills the model may name. */
function evidenceSections(m: SkillsMessageInput): string[] {
  const out: string[] = [];
  if (m.verifiedMatches.length > 0) {
    out.push('', '## Verified Matches (ledger evidence -- select honestly)');
    for (const v of m.verifiedMatches) out.push(`- ${v.skill} (${v.depth}, ${v.recency})`);
  }
  if (m.partialMatches.length > 0) {
    out.push('', '## Partial Matches (transferable evidence)');
    for (const p of m.partialMatches) out.push(`- ${p.skill} -- ${p.transferableFoundation}`);
  }
  return out;
}

/** JD technology inventory -- named buckets, omitted when empty. */
function inventorySection(jd: JdSignal): string[] {
  const inv = jd.technologyInventory;
  const buckets: Array<[string, string[]]> = [
    ['Languages', inv.languages],
    ['Frameworks', inv.frameworks],
    ['Infrastructure', inv.infrastructure],
    ['Tools', inv.tools],
    ['Methodologies', inv.methodologies],
  ];
  const nonEmpty = buckets.filter(([, items]) => items.length > 0);
  if (nonEmpty.length === 0) return [];
  const out = ['', '## Technology Inventory'];
  for (const [label, items] of nonEmpty) out.push(`${label}: ${items.join(', ')}`);
  return out;
}

/** Focused user message for the skills agent -- JD requirements, ledger
 *  evidence, technology inventory. No education content. */
export function buildSkillsMessage(m: SkillsMessageInput): string {
  return [
    `Target role: ${m.jd.targetRole}`,
    ...requirementsSection(m.jd),
    ...evidenceSections(m),
    ...inventorySection(m.jd),
  ].join('\n');
}
