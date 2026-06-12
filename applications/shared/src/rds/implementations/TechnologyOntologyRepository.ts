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

    /**
     * Group active, curated/auto-imported technologies by category.
     * Returns one array per category that has ≥2 members; singletons are
     * dropped because a group of 1 gives no transfer signal.
     * Used as a fallback when the relationships graph is empty.
     */
    async loadCategoryGroups(): Promise<string[][]> {
        const { rows } = await this.pool.query<{ canonical_name: string; category: string }>(
            `SELECT canonical_name, category
               FROM technology_ontology
              WHERE is_active = true
                AND curation_level IN ('curated', 'auto_imported')`,
        );
        const byCategory = new Map<string, string[]>();
        for (const r of rows) {
            const key = r.category;
            const list = byCategory.get(key);
            if (list !== undefined) {
                list.push(r.canonical_name.toLowerCase());
            } else {
                byCategory.set(key, [r.canonical_name.toLowerCase()]);
            }
        }
        const groups: string[][] = [];
        for (const members of byCategory.values()) {
            if (members.length >= 2) groups.push(members);
        }
        return groups;
    }

    /**
     * Compute connected components over the technology_relationships graph,
     * treating all relationship kinds as undirected edges. Returns each
     * component of ≥2 nodes as an array of lowercased canonical names.
     *
     * When the table is empty (no relationships seeded yet) returns [] so
     * the caller can fall back to loadCategoryGroups().
     *
     * Connected-components are found with a non-recursive union-find (safe
     * for any realistic ontology size).
     */
    async loadTransferGroups(): Promise<string[][]> {
        const { rows } = await this.pool.query<{ from_name: string; to_name: string }>(
            `SELECT f.canonical_name AS from_name, t.canonical_name AS to_name
               FROM technology_relationships r
               JOIN technology_ontology f ON f.id = r.from_id
               JOIN technology_ontology t ON t.id = r.to_id`,
        );
        if (rows.length === 0) return [];

        // Build adjacency map (undirected)
        const adj = new Map<string, Set<string>>();
        const addEdge = (a: string, b: string): void => {
            const aLow = a.toLowerCase();
            const bLow = b.toLowerCase();
            if (!adj.has(aLow)) adj.set(aLow, new Set());
            if (!adj.has(bLow)) adj.set(bLow, new Set());
            // Non-null assertions safe: we just set them above
            (adj.get(aLow) as Set<string>).add(bLow);
            (adj.get(bLow) as Set<string>).add(aLow);
        };
        for (const r of rows) addEdge(r.from_name, r.to_name);

        // BFS over adjacency map to find connected components
        const visited = new Set<string>();
        const components: string[][] = [];
        for (const node of adj.keys()) {
            if (visited.has(node)) continue;
            const component: string[] = [];
            const queue: string[] = [node];
            visited.add(node);
            while (queue.length > 0) {
                const current = queue.shift() as string;
                component.push(current);
                const neighbours = adj.get(current);
                if (neighbours !== undefined) {
                    for (const neighbour of neighbours) {
                        if (!visited.has(neighbour)) {
                            visited.add(neighbour);
                            queue.push(neighbour);
                        }
                    }
                }
            }
            if (component.length >= 2) components.push(component);
        }
        return components;
    }
}
