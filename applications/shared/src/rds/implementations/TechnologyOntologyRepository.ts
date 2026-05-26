/** @format */
import type { Pool } from 'pg';

/**
 * Reads the global technology ontology + aliases. Reference data is not
 * user-scoped, so no RLS / set_config needed.
 */
export class TechnologyOntologyRepository {
    constructor(private readonly pool: Pool) {}

    /** Load the full alias -> technology_id map (one query per Job). */
    async loadAliasMap(): Promise<Map<string, string>> {
        const { rows } = await this.pool.query<{ alias: string; technology_id: string }>(
            `SELECT alias, technology_id FROM technology_aliases`,
        );
        const map = new Map<string, string>();
        for (const r of rows) map.set(r.alias, r.technology_id);
        return map;
    }

    /**
     * Load the lowercase prose-safe alias set — the strings the ReadmeParser v2
     * prose scanner is allowed to match against free-form English. Caller-side
     * mitigation 1 from the 2026-05-26 ReadmeParser-v2 design: only aliases
     * tagged prose_safe=true (bootstrapped by ProseSafeTagger) participate
     * in the substring-against-prose scan; ambiguous ones (go/react/rust/
     * next/swift/spark/short abbreviations) only match in structured
     * contexts via the other extractor layers.
     *
     * Uses the partial index `idx_technology_aliases_prose_safe`
     * (migration 037 / chart migration-012).
     */
    async loadProseSafeAliases(): Promise<Set<string>> {
        const { rows } = await this.pool.query<{ alias: string }>(
            `SELECT alias FROM technology_aliases WHERE prose_safe = true`,
        );
        const set = new Set<string>();
        for (const r of rows) set.add(r.alias.toLowerCase());
        return set;
    }

    /** Current ontology version (for tagging evidence rows). */
    async currentVersion(): Promise<number> {
        const { rows } = await this.pool.query<{ version: number }>(
            `SELECT version FROM ontology_version WHERE singleton = TRUE`,
        );
        return rows[0]?.version ?? 1;
    }
}
