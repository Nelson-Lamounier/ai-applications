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
import { buildReverseAliasMap, mentionsCanonical } from './keyword-match.js';

/** Directory names that mark a doc as ILLUSTRATIVE (a pattern reference), not authored evidence. */
const REFERENCE_DIR_TOKENS = new Set([
    'checklist', 'checklists', 'reference', 'references', 'example', 'examples',
    'sample', 'samples', 'template', 'templates', 'tutorial', 'tutorials',
    'guide', 'guides', 'cheatsheet', 'cheatsheets', 'cheat-sheet',
    'snippet', 'snippets', 'howto', 'how-to', 'how-tos',
]);
/** Filename stems that mark the file itself as a reference/example. */
const REFERENCE_FILE_RE = /(checklist|example|sample|template|tutorial|cheat-?sheet|snippet|how-?to)/i;

/** A KB path that demonstrates a pattern rather than evidencing the candidate's own production work. */
export function isReferenceDoc(path: string): boolean {
    const segments = path.toLowerCase().split('/');
    const dirs = segments.slice(0, -1);
    if (dirs.some((d) => REFERENCE_DIR_TOKENS.has(d))) return true;
    const file = segments.at(-1) ?? '';
    return REFERENCE_FILE_RE.test(file);
}

/** Normalise free text to a space-padded token stream for whole-token containment. */
function padded(text: string): string {
    return ' ' + text.toLowerCase().replaceAll(/[^a-z0-9]+/g, ' ').trim() + ' ';
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
    const reverse = buildReverseAliasMap(aliasMap);
    const hay = padded(skill);
    for (const group of techGroups) {
        if (group.length < 2) continue;
        for (const member of group) {
            if (mentionsCanonical(member, hay, reverse)) {
                return { matched: member, siblings: group.filter((g) => g !== member) };
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

/** Why a competing-vendor match is demoted (drives the honest gap wording). */
type DemotionReason = 'reference-only' | 'absent-from-code';

/** True when the match is backed ONLY by reference/example docs (≥1 file, all reference). */
function isReferenceOnly(vm: VerifiedMatch): boolean {
    const files = vm.evidenceFiles ?? [];
    return files.length > 0 && files.every(isReferenceDoc);
}

/** Union of every repo's current code tech (lowercased canonicals). */
function allCodeTech(codeTechByRepo?: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
    const all = new Set<string>();
    for (const set of codeTechByRepo?.values() ?? []) for (const t of set) all.add(t);
    return all;
}

/**
 * Decide whether (and why) a competing-vendor match should be demoted:
 *   • reference-only — every evidence file is a reference/example doc (path heuristic).
 *   • absent-from-code — the claimed vendor is NOT in the candidate's code while an
 *     interchangeable SIBLING is (e.g. claims OpenAI, but the code uses Bedrock). This
 *     is robust where the path heuristic misses: a competing vendor backed by a normal
 *     doc but absent from authored code is not production work. Requires a sibling in
 *     code so a real transferable bridge exists; skipped when no code evidence loaded.
 */
function demotionReason(vm: VerifiedMatch, hit: VendorGroupHit, code: ReadonlySet<string>): DemotionReason | null {
    if (isReferenceOnly(vm)) return 'reference-only';
    if (code.size > 0 && !code.has(hit.matched) && hit.siblings.some((s) => code.has(s))) return 'absent-from-code';
    return null;
}

/** Build the honest transferable PartialMatch a demoted vendor becomes. */
function toPartial(vm: VerifiedMatch, hit: VendorGroupHit, reason: DemotionReason): PartialMatch {
    const siblingDisplay = hit.siblings.map((s) => s.replaceAll('_', ' ')).join(', ');
    const gap = reason === 'reference-only'
        ? `Evidence for "${vm.skill}" comes only from reference/example documentation, not authored production work.`
        : `"${vm.skill}" is not present in the candidate's authored code, which uses an interchangeable alternative (${siblingDisplay}) instead.`;
    return {
        skill: vm.skill,
        gapDescription: gap,
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
    deps: {
        techGroups: ReadonlyArray<ReadonlyArray<string>>;
        techAliasMap: ReadonlyMap<string, string>;
        /** Per-repo current code tech — enables the absent-from-code demotion. Optional/fail-open. */
        codeTechByRepo?: ReadonlyMap<string, ReadonlySet<string>>;
    },
): DemoteResult {
    if (deps.techGroups.length === 0) return { matching, demotions: [] };
    const code = allCodeTech(deps.codeTechByRepo);

    const keptVerified: VerifiedMatch[] = [];
    const demotedPartials: PartialMatch[] = [];
    const demotions: VendorDemotion[] = [];

    for (const vm of matching.verifiedMatches) {
        const hit = vendorGroupForSkill(vm.skill, deps.techGroups, deps.techAliasMap);
        const reason = hit ? demotionReason(vm, hit, code) : null;
        if (hit && reason) {
            demotedPartials.push(toPartial(vm, hit, reason));
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
