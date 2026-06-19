/** @format */
import type { Pool } from 'pg';

/**
 * Write-side access to the global skill ontology (skill_ontology +
 * skill_aliases) for the vocabulary importer. The skill twin of
 * OntologyWriteRepository, plus licence/source provenance (migration 095) and
 * the curated-guard: an import MUST NOT overwrite or deactivate a hand-curated
 * canonical (FR-008). Global reference data — no RLS, direct pool.query.
 */
export class SkillOntologyWriteRepository {
    constructor(private readonly pool: Pool) {}

    async findByCanonical(canonical: string): Promise<{ id: string; curationLevel: string } | null> {
        const { rows } = await this.pool.query<{ id: string; curation_level: string }>(
            `SELECT id, curation_level FROM skill_ontology WHERE canonical_name = $1`,
            [canonical],
        );
        return rows[0] ? { id: rows[0].id, curationLevel: rows[0].curation_level } : null;
    }

    /**
     * Upsert an imported canonical with provenance. Curated rows are NEVER
     * overwritten (FR-008): on a collision with a curated canonical, the existing
     * id is returned unchanged and the caller attaches the import's label as an
     * alias instead. Idempotent: re-importing an existing auto row refreshes only
     * its provenance.
     */
    async insertAutoImported(
        canonical: string,
        display: string,
        category: string,
        source: string,
        licence: string,
        url: string | null,
    ): Promise<{ id: string; curatedSkip: boolean }> {
        const existing = await this.findByCanonical(canonical);
        if (existing) {
            if (existing.curationLevel === 'curated') {
                return { id: existing.id, curatedSkip: true };
            }
            await this.pool.query(
                `UPDATE skill_ontology
                    SET source = $2, source_licence = $3, source_url = $4, updated_at = now()
                  WHERE id = $1`,
                [existing.id, source, licence, url],
            );
            return { id: existing.id, curatedSkip: false };
        }
        const { rows } = await this.pool.query<{ id: string }>(
            `INSERT INTO skill_ontology
                 (canonical_name, display_name, category, curation_level, source, source_licence, source_url)
             VALUES ($1, $2, $3, 'auto_imported', $4, $5, $6)
             RETURNING id`,
            [canonical, display, category, source, licence, url],
        );
        return { id: rows[0].id, curatedSkip: false };
    }

    async loadAliasMap(): Promise<Map<string, string>> {
        const { rows } = await this.pool.query<{ alias: string; skill_id: string }>(
            `SELECT alias, skill_id FROM skill_aliases`,
        );
        const m = new Map<string, string>();
        for (const r of rows) m.set(r.alias, r.skill_id);
        return m;
    }

    async insertAliases(skillId: string, aliases: readonly string[], source: string): Promise<number> {
        let inserted = 0;
        for (const a of aliases) {
            const cleaned = a.toLowerCase().trim();
            if (!cleaned) continue;
            const { rowCount } = await this.pool.query(
                `INSERT INTO skill_aliases (alias, skill_id, source) VALUES ($1, $2::uuid, $3)
                 ON CONFLICT (alias) DO NOTHING`,
                [cleaned, skillId, source],
            );
            inserted += rowCount ?? 0;
        }
        return inserted;
    }

    /**
     * Merge a duplicate canonical into the kept one (FR-006): re-point the
     * duplicate's aliases to the keep, attach the duplicate's name as an alias of
     * the keep, and deactivate the duplicate (kept for audit, not deleted).
     * Idempotent — a duplicate already inactive is a no-op.
     */
    async mergeCanonical(keepId: string, dropId: string, dropCanonical: string, source: string): Promise<void> {
        await this.pool.query(`UPDATE skill_aliases SET skill_id = $1::uuid WHERE skill_id = $2::uuid`, [keepId, dropId]);
        await this.pool.query(
            `INSERT INTO skill_aliases (alias, skill_id, source) VALUES ($1, $2::uuid, $3)
             ON CONFLICT (alias) DO NOTHING`,
            [dropCanonical.toLowerCase().trim(), keepId, source],
        );
        await this.pool.query(`UPDATE skill_ontology SET is_active = false, updated_at = now() WHERE id = $1`, [dropId]);
    }
}
