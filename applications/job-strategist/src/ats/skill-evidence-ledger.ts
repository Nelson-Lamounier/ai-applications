/**
 * @format
 * Skill Evidence Ledger — deterministic, per-tool evidence classification.
 *
 * For each JD-required tool/skill, builds a file-cited evidence row that maps
 * the candidate's matching evidence to one of three statuses:
 *   - verified: the tool is clearly demonstrated (with KB file citations)
 *   - transferable: related/partial/implied evidence exists (with bridging foundation)
 *   - gap: the tool matches one of the matcher's ACTUAL gaps (honest empty)
 *
 * HONESTY MODEL: a tool is `gap` ONLY when it matches a real matcher gap (the
 * authoritative "what's missing"). A verified competency phrased differently is
 * bridged to `verified` via token-overlap. A generic/implied competency the
 * matcher did NOT flag as missing is `transferable` (implied), never a false gap.
 *
 * Pure + deterministic + unit-tested. No LLM involved.
 */

import type { SkillEvidenceEntry, VerifiedMatch, PartialMatch, SkillGap } from '@bedrock/shared';
import { matchTier1, matchTechTransfer, tokenOverlapMatch } from './keyword-match.js';

/** The implied-transferable bridge used when a tool matches nothing the matcher flagged. */
const IMPLIED_BRIDGE =
    'Implied by the role\'s verified competencies — the matcher did not flag this as a gap.';

/**
 * Combined "semantic-ish" match: literal (bidirectional matchTier1) OR significant
 * token-overlap. Token-overlap bridges differently-phrased competencies — e.g.
 * "Critical thinking and root cause analysis" ↔ "...root-cause analysis".
 */
function combinedMatch(tool: string, skill: string): boolean {
    return matchTier1(tool, skill) || matchTier1(skill, tool) || tokenOverlapMatch(tool, skill);
}

/** Find a verified match for a given tool by combined (literal + token-overlap) match. */
function findVerifiedMatch(tool: string, verifiedMatches: VerifiedMatch[]): VerifiedMatch | undefined {
    return verifiedMatches.find((vm) => combinedMatch(tool, vm.skill));
}

/** Find a partial match for a given tool by combined (literal + token-overlap) match. */
function findPartialMatch(tool: string, partialMatches: PartialMatch[]): PartialMatch | undefined {
    return partialMatches.find((pm) => combinedMatch(tool, pm.skill));
}

/**
 * Find a matcher GAP for a given tool by combined (literal + token-overlap) match.
 * This is the ONLY path to `gap` status — the tool must match one of the matcher's
 * actual gaps (the authoritative "what's missing").
 */
function findGapMatch(tool: string, gaps: SkillGap[]): SkillGap | undefined {
    return gaps.find((g) => combinedMatch(tool, g.skill));
}

/** Options for tech-group-based transferable resolution. */
export interface LedgerOpts {
    /** Transfer/category groups — arrays of lowercased canonical tech names. */
    techGroups?: string[][];
    /** Alias → canonical map (lowercased keys). */
    techAliasMap?: Map<string, string>;
}

/**
 * Find the first verified match whose skill is a sibling of `tool` in any tech group.
 */
function findVerifiedSiblingByGroup(
    tool: string,
    verifiedMatches: VerifiedMatch[],
    techGroups: string[][],
    techAliasMap: Map<string, string>,
): VerifiedMatch | undefined {
    return verifiedMatches.find((vm) =>
        matchTechTransfer(tool, vm.skill, techGroups, techAliasMap),
    );
}

/**
 * Build a per-tool Skill Evidence Ledger from the JD tool list and the
 * research matching result.
 *
 * Status resolution order (per unique tool, preserving input order, case-insensitive dedupe):
 *  1. verified           — combined-match to a verifiedMatch
 *  2. transferable (group)— verified sibling in the same tech group (when opts provided)
 *  3. transferable (partial) — combined-match to a partialMatch
 *  4. gap                — combined-match to a matcher GAP (the ONLY path to gap)
 *  5. transferable (implied) — matched nothing the matcher flagged → implied competency
 *
 * @param tools    - JD-required tools/skills
 * @param matching - Research matching result (verifiedMatches + partialMatches + gaps)
 * @param opts     - Optional tech-group resolution config
 * @returns Ordered, deduped list of evidence entries
 */
export function buildSkillEvidenceLedger(
    tools: string[],
    matching: Pick<
        { verifiedMatches: VerifiedMatch[]; partialMatches: PartialMatch[]; gaps: SkillGap[] },
        'verifiedMatches' | 'partialMatches' | 'gaps'
    >,
    opts?: LedgerOpts,
): SkillEvidenceEntry[] {
    const seen = new Set<string>();
    const ledger: SkillEvidenceEntry[] = [];

    for (const tool of tools) {
        const key = tool.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        // 1. verified
        const vm = findVerifiedMatch(tool, matching.verifiedMatches);
        if (vm) {
            ledger.push({
                tool,
                status: 'verified',
                evidenceFiles: vm.evidenceFiles,
                evidence: vm.sourceCitation,
                transferableBridge: '',
            });
            continue;
        }

        // 2. transferable — verified sibling in the same tech group
        if (opts?.techGroups && opts.techAliasMap) {
            const sibling = findVerifiedSiblingByGroup(tool, matching.verifiedMatches, opts.techGroups, opts.techAliasMap);
            if (sibling) {
                ledger.push({
                    tool,
                    status: 'transferable',
                    evidenceFiles: sibling.evidenceFiles,
                    evidence: sibling.sourceCitation,
                    transferableBridge: `same technology group — ${sibling.skill} is transferable to ${tool}`,
                });
                continue;
            }
        }

        // 3. transferable — partial match
        const pm = findPartialMatch(tool, matching.partialMatches);
        if (pm) {
            ledger.push({
                tool,
                status: 'transferable',
                evidenceFiles: pm.evidenceFiles,
                evidence: pm.gapDescription,
                transferableBridge: pm.transferableFoundation,
            });
            continue;
        }

        // 4. gap — ONLY when the tool matches one of the matcher's actual gaps
        const gap = findGapMatch(tool, matching.gaps);
        if (gap) {
            ledger.push({
                tool,
                status: 'gap',
                evidenceFiles: [],
                evidence: '',
                transferableBridge: '',
            });
            continue;
        }

        // 5. transferable (implied) — matched nothing the matcher flagged as missing.
        // A generic/implied competency the matcher did NOT gap → transferable, NOT a false gap.
        ledger.push({
            tool,
            status: 'transferable',
            evidenceFiles: [],
            evidence: '',
            transferableBridge: IMPLIED_BRIDGE,
        });
    }

    return ledger;
}
