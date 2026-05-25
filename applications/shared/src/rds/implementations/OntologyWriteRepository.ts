/** @format */
import type { Pool } from 'pg';

/**
 * Write-side access to the global technology ontology (technology_ontology +
 * technology_aliases). Structurally implements the Tier 2 importer's
 * OntologyWritePort. These tables are GLOBAL (no RLS) — direct pool.query.
 */
export class OntologyWriteRepository {
    constructor(private readonly pool: Pool) {}

    async findByCanonical(canonical: string): Promise<{ id: string; curationLevel: string } | null> {
        const { rows } = await this.pool.query<{ id: string; curation_level: string }>(
            `SELECT id, curation_level FROM technology_ontology WHERE canonical_name = $1`,
            [canonical],
        );
        return rows[0] ? { id: rows[0].id, curationLevel: rows[0].curation_level } : null;
    }

    async insertAutoImported(
        canonical: string,
        display: string,
        category: string,
        source: string,
    ): Promise<string> {
        const { rows } = await this.pool.query<{ id: string }>(
            `INSERT INTO technology_ontology (canonical_name, display_name, category, curation_level, source)
             VALUES ($1, $2, $3, 'auto_imported', $4)
             ON CONFLICT (canonical_name) DO UPDATE SET canonical_name = EXCLUDED.canonical_name
             RETURNING id`,
            [canonical, display, category, source],
        );
        return rows[0].id;
    }

    async bumpPopularity(id: string, popularity: number | null): Promise<void> {
        if (popularity == null) return;
        await this.pool.query(
            `UPDATE technology_ontology SET popularity_score = GREATEST(popularity_score, $2) WHERE id = $1`,
            [id, popularity],
        );
    }

    async loadAliasMap(): Promise<Map<string, string>> {
        const { rows } = await this.pool.query<{ alias: string; technology_id: string }>(
            `SELECT alias, technology_id FROM technology_aliases`,
        );
        const m = new Map<string, string>();
        for (const r of rows) m.set(r.alias, r.technology_id);
        return m;
    }

    async insertAliases(technologyId: string, aliases: string[], source: string): Promise<number> {
        let inserted = 0;
        for (const a of aliases) {
            const { rowCount } = await this.pool.query(
                `INSERT INTO technology_aliases (alias, technology_id, source) VALUES ($1, $2::uuid, $3)
                 ON CONFLICT (alias) DO NOTHING`,
                [a, technologyId, source],
            );
            inserted += rowCount ?? 0;
        }
        return inserted;
    }
}
