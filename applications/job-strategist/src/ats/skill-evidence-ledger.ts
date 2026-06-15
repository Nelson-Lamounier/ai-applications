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
 * bridged to `verified` via token-overlap. A tool that matches NOTHING the matcher
 * assessed is DROPPED — it has no evidence to show in a "what your repos prove"
 * panel, and is often a false miss where the matcher assessed an equivalent skill
 * under different wording (the JD requirement still surfaces in the matcher's gaps).
 *
 * Pure + deterministic + unit-tested. No LLM involved.
 */

import type { SkillEvidenceEntry, VerifiedMatch, PartialMatch, SkillGap } from '@bedrock/shared';
import { matchTier1, matchTechTransfer, tokenOverlapMatch } from './keyword-match.js';

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
 *  1. verified           — combined-match to a verifiedMatch (direct evidence wins)
 *  2. gap (bridgeable)   — combined-match to a matcher GAP. The matcher's gaps are
 *                          the authoritative "what's missing", so a gap is honoured
 *                          even when a transferable foundation ALSO matches — a skill
 *                          the matcher flagged as missing must not read as a clean
 *                          positive. When a foundation exists it is kept as the
 *                          `transferableBridge` (a "bridgeable gap"): still a gap,
 *                          but the adjacent foundation is shown. This also stops the
 *                          deterministic hard years-bar (years-gap-reconcile) from
 *                          being silently downgraded to "transferable".
 *  3. transferable (group)— verified sibling in the same tech group (when opts provided)
 *  4. transferable (partial) — combined-match to a partialMatch
 *  5. (none)             — matched nothing the matcher assessed → DROPPED (no contentless row)
 *
 * @param tools    - JD-required tools/skills
 * @param matching - Research matching result (verifiedMatches + partialMatches + gaps)
 * @param opts     - Optional tech-group resolution config
 * @returns Ordered, deduped list of evidence entries
 */
/** A JD requirement expressing a years-of-experience bar (e.g. "8+ years …"). */
const YEARS_REQUIREMENT = /\b\d{1,2}\s*\+?\s*years?\b/i;
function isYearsRequirement(s: string): boolean {
    return YEARS_REQUIREMENT.test(s);
}

/** The transferable foundation (group sibling or partial) to keep on a bridgeable gap. */
function gapBridge(
    tool: string,
    matching: Pick<{ verifiedMatches: VerifiedMatch[]; partialMatches: PartialMatch[] }, 'verifiedMatches' | 'partialMatches'>,
    opts?: LedgerOpts,
): string {
    const sibling = opts?.techGroups && opts.techAliasMap
        ? findVerifiedSiblingByGroup(tool, matching.verifiedMatches, opts.techGroups, opts.techAliasMap)
        : undefined;
    if (sibling) return `same technology group — ${sibling.skill} is transferable to ${tool}`;
    return findPartialMatch(tool, matching.partialMatches)?.transferableFoundation ?? '';
}

/**
 * Resolve one JD tool to a ledger entry (or null = DROP). Resolution order
 * documented on {@link buildSkillEvidenceLedger}. Extracted to keep the builder
 * loop trivial.
 */
function resolveLedgerEntry(
    tool: string,
    matching: Pick<
        { verifiedMatches: VerifiedMatch[]; partialMatches: PartialMatch[]; gaps: SkillGap[] },
        'verifiedMatches' | 'partialMatches' | 'gaps'
    >,
    opts?: LedgerOpts,
): SkillEvidenceEntry | null {
    // 1. verified — direct evidence wins.
    const vm = findVerifiedMatch(tool, matching.verifiedMatches);
    if (vm) {
        return { tool, status: 'verified', evidenceFiles: vm.evidenceFiles, evidence: vm.sourceCitation, transferableBridge: '' };
    }

    // 2. gap (bridgeable) — the matcher's gaps are the authoritative "what's missing",
    // so a gap wins over any transferable foundation; the foundation is kept as the
    // bridge. A years-of-experience tool ALSO maps to a years gap even when the exact
    // wording differs (the #227 hard years-bar must never read as transferable).
    const gap = findGapMatch(tool, matching.gaps)
        ?? (isYearsRequirement(tool) ? matching.gaps.find((g) => isYearsRequirement(g.skill)) : undefined);
    if (gap) {
        return { tool, status: 'gap', evidenceFiles: [], evidence: '', transferableBridge: gapBridge(tool, matching, opts) };
    }

    // 3. transferable — verified sibling in the same tech group.
    if (opts?.techGroups && opts.techAliasMap) {
        const sibling = findVerifiedSiblingByGroup(tool, matching.verifiedMatches, opts.techGroups, opts.techAliasMap);
        if (sibling) {
            return {
                tool, status: 'transferable', evidenceFiles: sibling.evidenceFiles, evidence: sibling.sourceCitation,
                transferableBridge: `same technology group — ${sibling.skill} is transferable to ${tool}`,
            };
        }
    }

    // 4. transferable — partial match.
    const pm = findPartialMatch(tool, matching.partialMatches);
    if (pm) {
        return { tool, status: 'transferable', evidenceFiles: pm.evidenceFiles, evidence: pm.gapDescription, transferableBridge: pm.transferableFoundation };
    }

    // 5. DROP — matched nothing the matcher verified/partial'd/gapped. Emitting a
    // contentless row would read as a weak positive while proving nothing (and is
    // often a false miss where the matcher assessed an equivalent skill phrased
    // differently); the JD requirement still surfaces in the matcher's gaps/analysis.
    return null;
}

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

        const entry = resolveLedgerEntry(tool, matching, opts);
        if (entry) ledger.push(entry);
    }

    return ledger;
}
