/** @format */
import type { Pool } from 'pg';

/**
 * Reads the global skill ontology + aliases (migration 092). The deterministic
 * counterpart to TechnologyOntologyRepository — resolves the free-text `skills`
 * the LLM enricher emits to canonical skills, collapsing variance like
 * "k8s networking" ≈ "kubernetes networking".
 *
 * Reference data is not user-scoped, so no RLS / set_config needed. Built once
 * per Job and handed to the generic OntologyResolver (Map<alias,id>).
 */
export class SkillOntologyRepository {
    constructor(private readonly pool: Pool) {}

    /** Load the full alias -> skill_id map (one query per Job). */
    async loadAliasMap(): Promise<Map<string, string>> {
        const { rows } = await this.pool.query<{ alias: string; skill_id: string }>(
            `SELECT alias, skill_id FROM skill_aliases`,
        );
        const map = new Map<string, string>();
        for (const r of rows) map.set(r.alias, r.skill_id);
        return map;
    }

    /**
     * Load alias -> canonical_name (both lowercased) by joining aliases to the
     * ontology. Resolves a free-text skill phrase straight to its canonical name
     * — what the write-path canonicaliser (slice 2c) needs to dedup chunk skills.
     */
    async loadAliasToCanonicalMap(): Promise<Map<string, string>> {
        const { rows } = await this.pool.query<{ alias: string; canonical_name: string }>(
            `SELECT a.alias, o.canonical_name
               FROM skill_aliases a
               JOIN skill_ontology o ON o.id = a.skill_id`,
        );
        const map = new Map<string, string>();
        for (const r of rows) map.set(r.alias.toLowerCase(), r.canonical_name.toLowerCase());
        return map;
    }
}
