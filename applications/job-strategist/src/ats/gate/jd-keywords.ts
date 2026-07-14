/** @format */
import type { JdSignal, StrategistResearchResult } from '@bedrock/shared';

/**
 * JD must-have ATS terms = the technology inventory (all categories) of the single
 * JdSignal — atomic, deduped (case-insensitive), capped 18. This is the SAME signal
 * the writer targets and the "What we understood from your JD" UI shows, so the ATS
 * grades the resume against exactly what the JD agent extracted.
 *
 * Uses ONLY the (atomic) technologyInventory — never hardRequirements, whose `.skill`
 * is a requirement PHRASE ("8+ years…") that cannot keyword-match. Accepts any object
 * carrying a technologyInventory (JdSignal or the assembled StrategistResearchResult).
 */
export function collectJdMustHaves(
    jd: Pick<JdSignal, 'technologyInventory'>,
    onTruncated?: (dropped: string[]) => void,
): string[] {
    const out = new Set<string>();
    const seen = new Set<string>();
    const ti = jd.technologyInventory;
    for (const arr of [ti.tools, ti.languages, ti.methodologies, ti.frameworks, ti.infrastructure]) {
        for (const t of arr) {
            const s = t.trim();
            const key = s.toLowerCase();
            if (s && !seen.has(key)) {
                seen.add(key);
                out.add(s);
            }
        }
    }
    const all = [...out];
    // The cap keeps the check bounded, but truncation must never be silent —
    // a keyword-dense JD would otherwise read as "covered" for terms that
    // were never graded at all.
    if (all.length > 18) onTruncated?.(all.slice(18));
    return all.slice(0, 18);
}

/** Lowercased set of terms with KB evidence (verified or partial matches). */
export function collectGroundedTerms(r: StrategistResearchResult): Set<string> {
    const s = new Set<string>();
    for (const m of r.verifiedMatches) s.add(m.skill.toLowerCase());
    for (const m of r.partialMatches) s.add(m.skill.toLowerCase());
    return s;
}

/**
 * Grounded = the candidate has direct evidence (verified/partial match) OR the
 * term's transfer family (technology_relationships graph) contains an
 * evidenced skill — so an ATS "issue" can be raised for Podman when Docker is
 * evidenced daily, while a genuinely out-of-reach term (PyTorch with no ML
 * evidence anywhere) still never demands keyword stuffing.
 */
export function buildGroundedChecker(
    r: StrategistResearchResult,
    techGroups: string[][] = [],
    techAliasMap?: ReadonlyMap<string, string>,
): (term: string) => boolean {
    const direct = collectGroundedTerms(r);
    const canon = (t: string): string => techAliasMap?.get(t.trim().toLowerCase()) ?? t.trim().toLowerCase();
    const evidencedCanonicals = new Set([...direct].map(canon));
    return (term: string): boolean => {
        const key = term.trim().toLowerCase();
        if (direct.has(key)) return true;
        const c = canon(term);
        if (evidencedCanonicals.has(c)) return true;
        return techGroups.some((group) => group.includes(c) && group.some((member) => evidencedCanonicals.has(member)));
    };
}
