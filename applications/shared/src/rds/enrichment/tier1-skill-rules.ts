/** @format */

/**
 * Tier 1 of the tiered enrichment cascade (spec 003): deterministic skills from
 * a chunk's file technologies — ZERO model calls.
 *
 * A chunk's `metadata.file_tech_stack` (canonical technology names, produced by
 * the parallel extract_tech and stamped by stampUserEvidenceMetadata) is
 * file-cited evidence that the chunk's file uses those technologies. Mapping each
 * via `tech_skill_map` (tech_canonical -> canonical skills) yields the skills the
 * chunk evidences — the tool-skill plus the implied capability (aws_cdk ->
 * "aws cdk" + "infrastructure as code"). Membership in file_tech_stack IS the
 * per-chunk evidence (FR-008): a skill is assigned only because the chunk's file
 * deterministically evidences its technology.
 *
 * Pure + deterministic. Output is canonical-only (every value comes from the map,
 * whose skill side is FK'd to skill_ontology) so the `d.skills && query` overlap
 * lane matches (FR-006).
 */
export function tier1SkillsFromTech(
    fileTechStack: readonly string[],
    techSkillMap: ReadonlyMap<string, readonly string[]>,
): string[] {
    const out = new Set<string>();
    for (const techRaw of fileTechStack) {
        const skills = techSkillMap.get(techRaw.toLowerCase());
        if (skills) for (const s of skills) out.add(s);
    }
    return [...out];
}
