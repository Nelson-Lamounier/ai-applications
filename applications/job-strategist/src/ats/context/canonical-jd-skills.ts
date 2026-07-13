/**
 * @format
 * Canonical JD skill list — the single authoritative set of skills a JD requires,
 * derived ONCE from the jd-extractor signal.
 *
 * The pipeline must not maintain competing notions of "what the JD needs". This
 * collapses every JD-derived skill source (requiredSkills + the technology
 * inventory + preferred skills + the legacy `tools` field) into one ordered,
 * deduped list. Downstream — the matcher's assessment universe, the skill
 * evidence ledger, and ATS keyword coverage — all key off THIS list, so their
 * counts reconcile by construction instead of diverging per LLM re-read.
 *
 * Required/inventory skills lead (the hard asks), preferred skills follow.
 * Pure + deterministic + unit-tested. No LLM, no I/O.
 */

/** The jd-extractor fields this reads — kept structural to avoid an agent import. */
export interface JdSkillSource {
    readonly requiredSkills?: string[];
    readonly preferredSkills?: string[];
    /** Legacy flat tools field (older JdExtraction). */
    readonly tools?: string[];
    readonly technologyInventory?: {
        readonly languages?: string[];
        readonly frameworks?: string[];
        readonly infrastructure?: string[];
        readonly tools?: string[];
        readonly methodologies?: string[];
    };
}

/** Trim + drop empties, preserving order. */
function clean(xs: readonly string[] | undefined): string[] {
    return (xs ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Build the canonical, deduped (case-insensitive, first-occurrence wins) JD skill
 * list. Order: required skills + technology inventory (the hard asks) first, then
 * preferred skills.
 */
export function canonicalJdSkills(jd: JdSkillSource): string[] {
    const ti = jd.technologyInventory ?? {};
    const ordered = [
        ...clean(jd.requiredSkills),
        ...clean(ti.tools),
        ...clean(ti.languages),
        ...clean(ti.frameworks),
        ...clean(ti.infrastructure),
        ...clean(ti.methodologies),
        ...clean(jd.tools),
        ...clean(jd.preferredSkills),
    ];

    const seen = new Set<string>();
    const out: string[] = [];
    for (const skill of ordered) {
        const key = skill.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(skill);
    }
    return out;
}
