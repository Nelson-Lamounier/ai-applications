/**
 * @format
 * Build the structured retrieval pre-filter (filter-then-rank, Increment 2 of
 * docs/retrieval-filter-then-rank-spec.md) from the JD signal.
 *
 * The tech set is TRANSFER-AWARE: each JD technology is resolved to its ontology
 * canonical and expanded with its transfer-group siblings, so a hard exact-tech
 * filter never discards the transferable evidence the vendor/tech-transfer machinery
 * exists to surface (Bedrock chunks for an OpenAI JD). Pure + deterministic.
 */

import type { RetrievalPrefilter } from '@bedrock/shared';

function norm(s: string): string {
    return s.toLowerCase().trim();
}

/**
 * @param jdSkills  - JD required/preferred skills (free text).
 * @param jdTech    - JD technologies (tools/languages/frameworks/infrastructure).
 * @param techGroups- transfer groups of canonical tech names (lowercased).
 * @param aliasMap  - alias(lower) → canonical(lower).
 */
export function buildRetrievalPrefilter(
    jdSkills: ReadonlyArray<string>,
    jdTech: ReadonlyArray<string>,
    techGroups: ReadonlyArray<ReadonlyArray<string>>,
    aliasMap: ReadonlyMap<string, string>,
): RetrievalPrefilter {
    const skills = [...new Set(jdSkills.map(norm).filter((s) => s.length > 0))];

    // Resolve each JD tech term to a canonical.
    const canon = new Set<string>();
    for (const t of jdTech) {
        const lower = norm(t);
        if (lower.length === 0) continue;
        canon.add(aliasMap.get(lower) ?? lower.replaceAll(/\s+/g, '_'));
    }
    // Expand with transfer-group siblings (interchangeable techs).
    const tech = new Set(canon);
    for (const group of techGroups) {
        if (group.some((m) => canon.has(m))) {
            for (const m of group) tech.add(m);
        }
    }

    return { skills, tech: [...tech] };
}
