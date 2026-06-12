/**
 * @format
 * Skill Evidence Ledger — deterministic, per-tool evidence classification.
 *
 * For each JD-required tool/skill, builds a file-cited evidence row that maps
 * the candidate's matching evidence to one of three statuses:
 *   - verified: the tool is clearly demonstrated (with KB file citations)
 *   - transferable: related/partial evidence exists (with bridging foundation)
 *   - gap: no evidence found (honest empty)
 *
 * Pure + deterministic + unit-tested. No LLM involved.
 */

import type { SkillEvidenceEntry, VerifiedMatch, PartialMatch } from '@bedrock/shared';
import { matchTier1, matchTechTransfer } from './keyword-match.js';

/**
 * Find a verified match for a given tool by bidirectional matchTier1 lookup.
 *
 * Tries both directions:
 *   matchTier1(tool, verifiedMatch.skill)  — tool text searched in skill
 *   matchTier1(verifiedMatch.skill, tool)  — skill text searched in tool
 *
 * This lets "Python" find "Scripting and automation (Python/Bash)" via either direction.
 */
function findVerifiedMatch(tool: string, verifiedMatches: VerifiedMatch[]): VerifiedMatch | undefined {
    return verifiedMatches.find(
        (vm) => matchTier1(tool, vm.skill) || matchTier1(vm.skill, tool),
    );
}

/**
 * Find a partial match for a given tool by bidirectional matchTier1 lookup.
 */
function findPartialMatch(tool: string, partialMatches: PartialMatch[]): PartialMatch | undefined {
    return partialMatches.find(
        (pm) => matchTier1(tool, pm.skill) || matchTier1(pm.skill, tool),
    );
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
 *
 * A verified match is a sibling when:
 *   matchTechTransfer(tool, verifiedMatch.skill, techGroups, techAliasMap) is true
 * (i.e. the tool's canonical and the verified match's canonical share a group).
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
 * Algorithm (per unique tool, preserving input order, case-insensitive dedupe):
 *  1. Find a verifiedMatch → verified + evidenceFiles + sourceCitation as evidence
 *  2. Else find a partialMatch → transferable + evidenceFiles + transferableFoundation as bridge
 *  3. Else if opts.techGroups provided: find a verified sibling in the same tech group
 *     → transferable + sibling's evidenceFiles + transferableBridge describing the group link
 *  4. Else → gap (honest: empty files, empty evidence)
 *
 * @param tools    - JD-required tools/skills (from technologyInventory.tools + requiredSkills, etc.)
 * @param matching - Research matching result (verifiedMatches + partialMatches)
 * @param opts     - Optional tech-group resolution config (back-compat: omit for original behaviour)
 * @returns Ordered, deduped list of evidence entries
 */
export function buildSkillEvidenceLedger(
    tools: string[],
    matching: Pick<{ verifiedMatches: VerifiedMatch[]; partialMatches: PartialMatch[] }, 'verifiedMatches' | 'partialMatches'>,
    opts?: LedgerOpts,
): SkillEvidenceEntry[] {
    const seen = new Set<string>();
    const ledger: SkillEvidenceEntry[] = [];

    for (const tool of tools) {
        const key = tool.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

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

        if (opts?.techGroups && opts.techAliasMap) {
            const sibling = findVerifiedSiblingByGroup(tool, matching.verifiedMatches, opts.techGroups, opts.techAliasMap);
            if (sibling) {
                const verifiedTech = sibling.skill;
                ledger.push({
                    tool,
                    status: 'transferable',
                    evidenceFiles: sibling.evidenceFiles,
                    evidence: sibling.sourceCitation,
                    transferableBridge: `same technology group — ${verifiedTech} is transferable to ${tool}`,
                });
                continue;
            }
        }

        ledger.push({
            tool,
            status: 'gap',
            evidenceFiles: [],
            evidence: '',
            transferableBridge: '',
        });
    }

    return ledger;
}
