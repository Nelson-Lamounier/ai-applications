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

type Matching = Pick<
    { verifiedMatches: VerifiedMatch[]; partialMatches: PartialMatch[]; gaps: SkillGap[] },
    'verifiedMatches' | 'partialMatches' | 'gaps'
>;

/**
 * A resolved entry plus the matcher skill it resolved against (`matchedSkill`).
 * The latter lets the builder dedupe: a JD tool and a matcher-assessed skill that
 * resolve to the SAME underlying assessment produce ONE row, not two.
 */
interface Resolved {
    readonly entry: SkillEvidenceEntry;
    readonly matchedSkill: string;
}

/**
 * Resolve one label (a JD tool OR a matcher skill) to a ledger entry, reporting
 * the matcher skill it matched. null = DROP. Resolution order documented on
 * {@link buildSkillEvidenceLedger}.
 */
function resolveLedgerEntry(tool: string, matching: Matching, opts?: LedgerOpts): Resolved | null {
    // 1. verified — direct evidence wins.
    const vm = findVerifiedMatch(tool, matching.verifiedMatches);
    if (vm) {
        return { matchedSkill: vm.skill, entry: { tool, status: 'verified', evidenceFiles: vm.evidenceFiles, evidence: vm.sourceCitation, transferableBridge: '' } };
    }

    // 2. gap (bridgeable) — the matcher's gaps are the authoritative "what's missing",
    // so a gap wins over any transferable foundation; the foundation is kept as the
    // bridge. A years-of-experience tool ALSO maps to a years gap even when the exact
    // wording differs (the #227 hard years-bar must never read as transferable).
    const gap = findGapMatch(tool, matching.gaps)
        ?? (isYearsRequirement(tool) ? matching.gaps.find((g) => isYearsRequirement(g.skill)) : undefined);
    if (gap) {
        return { matchedSkill: gap.skill, entry: { tool, status: 'gap', evidenceFiles: [], evidence: '', transferableBridge: gapBridge(tool, matching, opts) } };
    }

    // 3. transferable — verified sibling in the same tech group.
    if (opts?.techGroups && opts.techAliasMap) {
        const sibling = findVerifiedSiblingByGroup(tool, matching.verifiedMatches, opts.techGroups, opts.techAliasMap);
        if (sibling) {
            return {
                matchedSkill: sibling.skill,
                entry: { tool, status: 'transferable', evidenceFiles: sibling.evidenceFiles, evidence: sibling.sourceCitation, transferableBridge: `same technology group — ${sibling.skill} is transferable to ${tool}` },
            };
        }
    }

    // 4. transferable — partial match.
    const pm = findPartialMatch(tool, matching.partialMatches);
    if (pm) {
        return { matchedSkill: pm.skill, entry: { tool, status: 'transferable', evidenceFiles: pm.evidenceFiles, evidence: pm.gapDescription, transferableBridge: pm.transferableFoundation } };
    }

    // 5. DROP — matched nothing the matcher verified/partial'd/gapped. A JD tool that
    // hits nothing the matcher assessed is omitted (no contentless row); the matcher's
    // OWN skills are added separately below so nothing assessed is lost.
    return null;
}

/**
 * Build the Skill Evidence Ledger as the UNION of the JD's named tools and the
 * matcher's assessed skills (verified + partial + gaps), deduped so each
 * underlying assessment yields exactly one row.
 *
 * JD tools are processed FIRST (clean, JD-faithful row labels + ATS keyword
 * coverage). Then every matcher-assessed skill not already represented by a JD
 * tool is appended (using the matcher's own wording). The result therefore
 * covers EVERYTHING the matcher assessed — the ledger reconciles with the
 * matcher's verified/partial/gap counts instead of being a narrower JD-tool-only
 * slice — while JD-named tools that hit nothing are still dropped.
 *
 * Per-label resolution order: verified → gap(bridgeable) → transferable(group)
 * → transferable(partial) → (JD tool only) drop. Pure + deterministic.
 */
export function buildSkillEvidenceLedger(tools: string[], matching: Matching, opts?: LedgerOpts): SkillEvidenceEntry[] {
    const seenLabels = new Set<string>();   // exact label dedupe
    const coveredSkills = new Set<string>(); // matcher skills already represented (identity dedupe)
    const ledger: SkillEvidenceEntry[] = [];

    const add = (label: string): void => {
        const key = label.toLowerCase();
        if (!label || seenLabels.has(key)) return;
        seenLabels.add(key);
        const res = resolveLedgerEntry(label, matching, opts);
        if (!res) return;
        const skillKey = res.matchedSkill.toLowerCase();
        if (coveredSkills.has(skillKey)) return; // same assessment already has a row
        coveredSkills.add(skillKey);
        ledger.push(res.entry);
    };

    // 1. JD-named tools first (clean labels + ATS coverage).
    for (const tool of tools) add(tool);
    // 2. Every matcher-assessed skill not yet represented (covers all 18 assessed).
    for (const m of matching.verifiedMatches) add(m.skill);
    for (const m of matching.partialMatches) add(m.skill);
    for (const g of matching.gaps) add(g.skill);

    return ledger;
}
