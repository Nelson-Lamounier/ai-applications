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

    /**
     * Load active canonical skills that still lack an embedding (migration 094),
     * for the Titan backfill. Bounded by `limit` so the backfill drains in
     * batches. Empty array once every active skill is embedded.
     */
    async loadCanonicalsNeedingEmbedding(limit: number): Promise<{ id: string; canonicalName: string }[]> {
        const { rows } = await this.pool.query<{ id: string; canonical_name: string }>(
            `SELECT id, canonical_name
               FROM skill_ontology
              WHERE embedding IS NULL AND is_active = true
              ORDER BY canonical_name
              LIMIT $1`,
            [limit],
        );
        return rows.map(r => ({ id: r.id, canonicalName: r.canonical_name }));
    }

    /** Persist a canonical skill's embedding vector (migration 094). */
    async updateEmbedding(id: string, embedding: readonly number[]): Promise<void> {
        await this.pool.query(
            `UPDATE skill_ontology SET embedding = $2::vector, updated_at = now() WHERE id = $1`,
            [id, `[${embedding.join(',')}]`],
        );
    }
}
