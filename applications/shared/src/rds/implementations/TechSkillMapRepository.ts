/** @format */
import type { Pool } from 'pg';

/**
 * Reads the tech -> skill rule map (migration 096) for Tier 1 of the tiered
 * enrichment cascade (spec 003). Reference data, not user-scoped — built once
 * per Job and handed to the pure `tier1SkillsFromTech` mapper.
 *
 * Returns `tech_canonical -> canonical skills[]` (lowercased tech key), so a
 * chunk's file_tech_stack resolves to skills with zero model calls.
 */
export class TechSkillMapRepository {
    constructor(private readonly pool: Pool) {}

    /** Load the full tech -> skills[] map (one query per Job). */
    async loadTechSkillMap(): Promise<Map<string, string[]>> {
        const { rows } = await this.pool.query<{ tech_canonical: string; skill_canonical: string }>(
            `SELECT tech_canonical, skill_canonical FROM tech_skill_map`,
        );
        const map = new Map<string, string[]>();
        for (const r of rows) {
            const key = r.tech_canonical.toLowerCase();
            const list = map.get(key);
            if (list) list.push(r.skill_canonical);
            else map.set(key, [r.skill_canonical]);
        }
        return map;
    }
}
