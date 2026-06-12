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
export function collectJdMustHaves(jd: Pick<JdSignal, 'technologyInventory'>): string[] {
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
    return [...out].slice(0, 18);
}

/** Lowercased set of terms with KB evidence (verified or partial matches). */
export function collectGroundedTerms(r: StrategistResearchResult): Set<string> {
    const s = new Set<string>();
    for (const m of r.verifiedMatches) s.add(m.skill.toLowerCase());
    for (const m of r.partialMatches) s.add(m.skill.toLowerCase());
    return s;
}
