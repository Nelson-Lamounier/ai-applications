/**
 * @format
 * Vendor-provenance guard — demote competing-vendor matches that are backed
 * ONLY by reference/example documentation, not authored production work.
 *
 * THE BUG THIS KILLS: a candidate's own how-to/checklist doc shows an *example*
 * snippet for a vendor they do NOT use (e.g. an "OpenAI example (Python)" block
 * in a structured-output checklist, while their real stack is Bedrock/Anthropic).
 * The research LLM cites that doc and marks the vendor VERIFIED, and the writer
 * then states it as first-person production experience ("integrated production
 * OpenAI API") — a fabrication.
 *
 * THE RULE (deterministic, two conditions, both required):
 *   (a) PROVIDER-EXCLUSIVITY — the match's skill names a member of a tech-transfer
 *       group (interchangeable/competing technologies). Membership guarantees an
 *       honest transferable bridge exists (the sibling the candidate actually uses).
 *   (b) REFERENCE-ONLY EVIDENCE — every evidenceFile is a reference/example doc
 *       (checklist, example, sample, template, tutorial, guide, snippet) by path.
 *       A match with ANY authored-source file, or with no files (career evidence),
 *       is left untouched.
 *
 * When both hold, the verifiedMatch becomes a partialMatch (transferable) framed
 * honestly via its sibling vendors — never a literal production claim. The gate on
 * (a) is what protects genuinely-held skills cited from the same doc (e.g. "Python"
 * is not a competing-vendor group → stays verified).
 *
 * Pure + deterministic. No LLM. FAIL-SAFE: no groups → no change.
 */

import type { ResearchMatching, VerifiedMatch, PartialMatch } from '@bedrock/shared';

/** Path segments / filename tokens that mark a doc as ILLUSTRATIVE, not authored evidence. */
const REFERENCE_PATH_RE = /\/(checklists?|reference|examples?|samples?|templates?|tutorials?|guides?|cheat-?sheets?|snippets?|how-?tos?)\//i;
const REFERENCE_FILE_RE = /(?:^|\/)[^/]*(checklist|example|sample|template|tutorial|cheat-?sheet|snippet|how-?to)[^/]*\.[a-z]+$/i;

/** A KB path that demonstrates a pattern rather than evidencing the candidate's own production work. */
export function isReferenceDoc(path: string): boolean {
    return REFERENCE_PATH_RE.test(path) || REFERENCE_FILE_RE.test(path);
}

/** Build canonical → [aliases] from the alias→canonical map. */
function reverseAliases(aliasMap: ReadonlyMap<string, string>): Map<string, string[]> {
    const reverse = new Map<string, string[]>();
    for (const [alias, canonical] of aliasMap) {
        const existing = reverse.get(canonical);
        if (existing) existing.push(alias);
        else reverse.set(canonical, [alias]);
    }
    return reverse;
}

/** Normalise free text to a space-padded token stream for whole-token containment. */
function padded(text: string): string {
    return ' ' + text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
}

export interface VendorGroupHit {
    /** The group member the skill names (e.g. "openai"). */
    readonly matched: string;
    /** The other interchangeable members — the honest transferable bridge (e.g. ["claude","bedrock"]). */
    readonly siblings: string[];
}

/**
 * Resolve which transfer-group a free-text skill names, if any. Scans every group
 * member's surface forms (display form + aliases) for a whole-token appearance in
 * the skill text. Only groups with ≥2 members qualify (a sibling must exist).
 */
export function vendorGroupForSkill(
    skill: string,
    techGroups: ReadonlyArray<ReadonlyArray<string>>,
    aliasMap: ReadonlyMap<string, string>,
): VendorGroupHit | null {
    const reverse = reverseAliases(aliasMap);
    const hay = padded(skill);
    for (const group of techGroups) {
        if (group.length < 2) continue;
        for (const member of group) {
            const surfaceForms = new Set([member.replace(/_/g, ' '), ...(reverse.get(member) ?? [])]);
            for (const form of surfaceForms) {
                const norm = padded(form).trim();
                if (norm.length >= 3 && hay.includes(` ${norm} `)) {
                    return { matched: member, siblings: group.filter((g) => g !== member) };
                }
            }
        }
    }
    return null;
}

/** One demoted match — for telemetry + the demotion log. */
export interface VendorDemotion {
    readonly skill: string;
    readonly matchedVendor: string;
    readonly siblings: string[];
    readonly evidenceFiles: string[];
}

export interface DemoteResult {
    /** Corrected matching: offending verifiedMatches moved to partialMatches. */
    readonly matching: ResearchMatching;
    /** What was demoted (empty when nothing changed). */
    readonly demotions: VendorDemotion[];
}

/** True when the match is backed ONLY by reference/example docs (≥1 file, all reference). */
function isReferenceOnly(vm: VerifiedMatch): boolean {
    const files = vm.evidenceFiles ?? [];
    return files.length > 0 && files.every(isReferenceDoc);
}

/** Build the honest transferable PartialMatch a demoted vendor becomes. */
function toPartial(vm: VerifiedMatch, hit: VendorGroupHit): PartialMatch {
    const siblingDisplay = hit.siblings.map((s) => s.replace(/_/g, ' ')).join(', ');
    return {
        skill: vm.skill,
        gapDescription: `Evidence for "${vm.skill}" comes only from reference/example documentation, not authored production work.`,
        transferableFoundation: `Hands-on experience with interchangeable alternatives in the same technology family (${siblingDisplay}).`,
        framingSuggestion: `Frame as transferable from ${siblingDisplay}. Do NOT claim direct production use of ${vm.skill}.`,
        evidenceFiles: vm.evidenceFiles ?? [],
    };
}

/**
 * Demote competing-vendor verifiedMatches that are backed only by reference docs.
 * Returns the corrected matching (verified moved to partial) + the demotion list.
 * FAIL-SAFE: no tech groups → returns the input unchanged.
 */
export function demoteMisattributedVendors(
    matching: ResearchMatching,
    deps: { techGroups: ReadonlyArray<ReadonlyArray<string>>; techAliasMap: ReadonlyMap<string, string> },
): DemoteResult {
    if (deps.techGroups.length === 0) return { matching, demotions: [] };

    const keptVerified: VerifiedMatch[] = [];
    const demotedPartials: PartialMatch[] = [];
    const demotions: VendorDemotion[] = [];

    for (const vm of matching.verifiedMatches) {
        const hit = isReferenceOnly(vm) ? vendorGroupForSkill(vm.skill, deps.techGroups, deps.techAliasMap) : null;
        if (hit) {
            demotedPartials.push(toPartial(vm, hit));
            demotions.push({ skill: vm.skill, matchedVendor: hit.matched, siblings: hit.siblings, evidenceFiles: vm.evidenceFiles ?? [] });
        } else {
            keptVerified.push(vm);
        }
    }

    if (demotions.length === 0) return { matching, demotions: [] };
    return {
        matching: {
            ...matching,
            verifiedMatches: keptVerified,
            partialMatches: [...matching.partialMatches, ...demotedPartials],
        },
        demotions,
    };
}
