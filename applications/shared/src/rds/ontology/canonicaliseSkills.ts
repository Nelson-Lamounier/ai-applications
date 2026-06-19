/** @format */

/**
 * Canonicalise a list of free-text skill phrases through the shared three-stage
 * cascade — the SINGLE source of truth used by BOTH sides of the
 * `d.skills && query.skills` retrieval overlap:
 *
 *   1. lowercase / trim / drop empties + non-strings
 *   2. exact alias -> canonical (cheap, deterministic; migration 092)
 *   3. residual only: embedding nearest-canonical (resolveSkill), else raw
 *
 * Why it's shared: the corpus side (BedrockChunkEnricher, on write) and the
 * query side (JD/resume skills, on read) MUST resolve identically — if a phrase
 * the corpus collapsed by embedding is left raw on the query side, the array
 * overlap silently misses. Extracting the cascade here guarantees they cannot
 * drift. Stage 3 is skipped when no resolver is wired (alias-only), and is
 * fail-safe (any resolver error keeps the raw phrase, never throws).
 */
export async function canonicaliseSkills(
    raw: unknown,
    aliasToCanonical?: ReadonlyMap<string, string>,
    resolveSkill?: (phrase: string) => Promise<string | null>,
): Promise<string[]> {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    for (const v of raw) {
        if (typeof v !== 'string') continue;
        const cleaned = v.toLowerCase().trim();
        if (!cleaned) continue;
        const alias = aliasToCanonical?.get(cleaned);
        if (alias) { seen.add(alias); continue; }
        const fuzzy = resolveSkill
            ? await resolveSkill(cleaned).catch(() => null)
            : null;
        seen.add(fuzzy ?? cleaned);
    }
    return Array.from(seen);
}
