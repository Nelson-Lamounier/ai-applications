/**
 * @format
 * Skills-agent per-phase eval - offline structural graders.
 *
 * `membershipGrader`/`capsGrader` DELEGATE to `validateSkillsMembership`
 * (skills-validate.ts) -- the exact ledger-membership contract the runtime
 * splice enforces -- so "eval says good" and "guard accepts" can never drift.
 * `jdPriorityGrader` restates skills-validate.ts's bidirectional matchTier1 +
 * exact-lowercase formula locally (no cross-module coupling to that file's
 * private `skillMatchesTool`), the same pattern projects-graders.ts uses for
 * `distinctiveTokens`. No Bedrock call - pure, deterministic checks against a
 * fixed SkillsEvalInput.
 */
import type { SkillEvidenceEntry } from '@bedrock/shared';
import { matchTier1 } from '../../ats/matching/keyword-match.js';
import { validateSkillsMembership } from '../../agents/writer/skills-validate.js';
import type { SkillsAgentOutput } from '../../agents/writer/skills-schema.js';
import { mkResult, type GraderResult } from '../graders.js';

/** The exact output the skills phase produces + the ledger and JD-required-skill context it was graded against. */
export interface SkillsEvalInput {
    readonly output: SkillsAgentOutput;
    readonly ledger: readonly SkillEvidenceEntry[];
    /** JD requiredSkills (hard requirements' skill names) -- the priority signal jdPriorityGrader checks against. */
    readonly requiredSkills: readonly string[];
}

/** Bidirectional matchTier1 (either side may be the "term", either the "haystack") plus exact-lowercase -- restates skills-validate.ts's `skillMatchesTool` formula. */
function skillMatchesTerm(skillName: string, term: string): boolean {
    if (skillName.trim().toLowerCase() === term.trim().toLowerCase()) return true;
    return matchTier1(skillName, term) || matchTier1(term, skillName);
}

/** Ledger-membership: every emitted skill resolves to a verified/transferable ledger tool. Reuses validateSkillsMembership -- does not re-check the rule. */
export function membershipGrader(i: SkillsEvalInput): GraderResult {
    const violations = validateSkillsMembership(i.output, i.ledger).filter((v) => v.startsWith('unknown_skill:'));
    return mkResult('membership', violations);
}

/** Shape caps: <=5 categories, <=8 items/category. Reuses the SAME validator call as membershipGrader, filtered to the cap tokens -- one source of truth for the 5/8 constants. */
export function capsGrader(i: SkillsEvalInput): GraderResult {
    const violations = validateSkillsMembership(i.output, i.ledger).filter(
        (v) => v.startsWith('category_cap:') || v.startsWith('item_cap:'),
    );
    return mkResult('caps', violations);
}

/**
 * JD priority: when at least one JD-required skill is attainable (present in
 * the ledger's VERIFIED set), the first category's first skill must match one
 * of those attainable required skills. Vacuous when no required skill is
 * attainable -- nothing to prioritise.
 */
export function jdPriorityGrader(i: SkillsEvalInput): GraderResult {
    const verifiedTools = i.ledger.filter((e) => e.status === 'verified').map((e) => e.tool);
    const attainableRequired = i.requiredSkills.filter((rs) => verifiedTools.some((tool) => skillMatchesTerm(rs, tool)));
    if (attainableRequired.length === 0) return mkResult('jdPriority', []);

    const lead = i.output.skills[0]?.skills[0];
    if (!lead) {
        return mkResult('jdPriority', [`no lead skill emitted, but JD-required skills are attainable: ${attainableRequired.join(', ')}`]);
    }
    const matches = attainableRequired.some((rs) => skillMatchesTerm(lead, rs));
    return mkResult(
        'jdPriority',
        matches ? [] : [`lead skill "${lead}" does not match any attainable JD-required skill (${attainableRequired.join(', ')})`],
    );
}

/** All structural graders, in display order. */
export const SKILLS_GRADERS = [membershipGrader, capsGrader, jdPriorityGrader] as const;

/** Run every grader; overall pass = all pass. */
export function runSkillsGraders(i: SkillsEvalInput): { pass: boolean; results: GraderResult[] } {
    const results = SKILLS_GRADERS.map((g) => g(i));
    return { pass: results.every((r) => r.pass), results };
}
