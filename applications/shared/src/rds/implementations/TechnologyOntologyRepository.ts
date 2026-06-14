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
     * Load alias -> canonical_name (both lowercased) by joining aliases to the
     * ontology. Unlike `loadAliasMap` (alias -> technology_id UUID), this resolves
     * a free-text technology phrase straight to its canonical name — what the
     * doc-vs-code drift guard needs to recognise a documented technology.
     */
    async loadAliasToCanonicalMap(): Promise<Map<string, string>> {
        const { rows } = await this.pool.query<{ alias: string; canonical_name: string }>(
            `SELECT a.alias, o.canonical_name
               FROM technology_aliases a
               JOIN technology_ontology o ON o.id = a.technology_id`,
        );
        const map = new Map<string, string>();
        for (const r of rows) map.set(r.alias.toLowerCase(), r.canonical_name.toLowerCase());
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

    /**
     * Load each repo's code-derived technology set for a user — the deterministic
     * -from-code evidence (Syft SBOM, TreeSitter AST, IaC manifests, Dockerfiles),
     * resolved to ontology canonical names. README/code-prose layers are EXCLUDED:
     * prose mentions can be as stale as the docs being checked, so they are not code
     * ground-truth.
     *
     * Aggregated across ALL extracted commits, NOT a single "latest" commit. The
     * tech-extractor runs incrementally, so no single commit_sha holds the complete
     * canonical set — and a partial/placeholder run (e.g. commit_sha='HEAD') as the
     * newest would otherwise SHADOW the real evidence, silently emptying the code set
     * (observed in prod: aws_eks present in 12 files but 0 under the latest commit).
     * Code presence is cumulative truth ("the repo uses aws_eks"), so the union is
     * correct; predecessors removed in a migration (kubeadm/self-hosted) are not
     * code-detectable anyway, so this does not weaken the doc-vs-code reconciliation.
     *
     * Returns repoFullName -> Set of lowercased canonical names. This is the truth a
     * doc claim is reconciled against: if a `.md` says "self-hosted Kubernetes" but a
     * repo's code set contains `aws_eks` (and not the self-hosted entity), the doc is
     * stale. Empty map when no evidence exists (fail-safe — callers skip reconciliation).
     */
    async loadRepoCodeTech(userId: string): Promise<Map<string, Set<string>>> {
        const { rows } = await this.pool.query<{ repo_full_name: string; canonical: string }>(
            `SELECT DISTINCT te.repo_full_name, lower(o.canonical_name) AS canonical
               FROM technology_evidence te
               JOIN technology_ontology o ON o.id = te.technology_id
              WHERE te.user_id = $1
                AND te.source_layer IN ('syft', 'treesitter', 'iac', 'dockerfile')`,
            [userId],
        );
        const byRepo = new Map<string, Set<string>>();
        for (const r of rows) {
            let set = byRepo.get(r.repo_full_name);
            if (set === undefined) {
                set = new Set();
                byRepo.set(r.repo_full_name, set);
            }
            set.add(r.canonical);
        }
        return byRepo;
    }

    /**
     * Load canonical tech → the CODE files that actually use it, for a user. This is the
     * structured "proof" lane behind the Skill Evidence Ledger: a deterministic answer to
     * "which authored code files demonstrate this technology?" — unlike cosine retrieval,
     * which surfaces prose docs and lexically-similar-but-irrelevant files.
     *
     * Code layers only (syft/treesitter/iac/dockerfile — never README/code-prose), paths
     * as `${repo}/${file}`. Returns canonical(lower) → ordered unique paths. Empty map
     * when no code evidence exists (callers fail-safe).
     *
     * Aggregated across ALL commits (not a single "latest"): the tech-extractor extracts
     * incrementally, so the complete file set for a canonical spans commits, and a
     * partial/placeholder newest run (commit_sha='HEAD') would otherwise shadow it and
     * empty the proof lane. Code presence is cumulative, so the union is the right model.
     */
    async loadCanonicalToCodeFiles(userId: string): Promise<Map<string, string[]>> {
        const { rows } = await this.pool.query<{ canonical: string; path: string }>(
            `SELECT lower(o.canonical_name) AS canonical,
                    te.repo_full_name || '/' || te.file_path AS path
               FROM technology_evidence te
               JOIN technology_ontology o ON o.id = te.technology_id
              WHERE te.user_id = $1
                AND te.source_layer IN ('syft', 'treesitter', 'iac', 'dockerfile')
              GROUP BY lower(o.canonical_name), te.repo_full_name || '/' || te.file_path
              ORDER BY 1, 2`,
            [userId],
        );
        const byCanonical = new Map<string, string[]>();
        for (const r of rows) {
            const list = byCanonical.get(r.canonical);
            if (list === undefined) byCanonical.set(r.canonical, [r.path]);
            else list.push(r.path);
        }
        return byCanonical;
    }

    /**
     * Load the DISTINCT ingested file paths per repo for a user — the union of paths
     * seen by the doc-chunker (document_embeddings) and the code extractor
     * (technology_evidence). A run-time evidence-topology proxy for the repo file tree
     * (test files, migrations dirs, nested package.json) without re-reading the repo.
     * Partial by construction (only ingested/extracted files), but test files in
     * particular are richly captured. Empty map when nothing ingested.
     */
    async loadRepoFilePaths(userId: string): Promise<Map<string, Set<string>>> {
        const { rows } = await this.pool.query<{ repo_full_name: string; file_path: string }>(
            `SELECT DISTINCT repo_full_name, file_path FROM document_embeddings WHERE user_id = $1
             UNION
             SELECT DISTINCT repo_full_name, file_path FROM technology_evidence WHERE user_id = $1`,
            [userId],
        );
        const byRepo = new Map<string, Set<string>>();
        for (const r of rows) {
            let set = byRepo.get(r.repo_full_name);
            if (set === undefined) {
                set = new Set();
                byRepo.set(r.repo_full_name, set);
            }
            set.add(r.file_path);
        }
        return byRepo;
    }

    /**
     * Load each repo's evidence topology (repo_sync_state.evidence_topology — the
     * manifest+tree evidence: package.json scripts, DB-migration ecosystem, monorepo)
     * for a user. Feeds the Repository Profile builder. Empty map when none stored.
     */
    async loadRepoEvidenceTopology(userId: string): Promise<Map<string, Record<string, unknown>>> {
        const { rows } = await this.pool.query<{ repo_full_name: string; evidence_topology: Record<string, unknown> | null }>(
            `SELECT repo_full_name, evidence_topology
               FROM repo_sync_state
              WHERE user_id = $1 AND evidence_topology IS NOT NULL`,
            [userId],
        );
        const map = new Map<string, Record<string, unknown>>();
        for (const r of rows) {
            if (r.evidence_topology) map.set(r.repo_full_name, r.evidence_topology);
        }
        return map;
    }

    /**
     * Load each repo's archetype signals (repo_sync_state.archetype_signals — the
     * folder-structure scan: has_iac, has_k8s_manifests, has_argocd_apps, …) for a
     * user. Feeds the Repository Profile builder. Empty map when none stored.
     */
    async loadRepoArchetypeSignals(userId: string): Promise<Map<string, Record<string, boolean>>> {
        const { rows } = await this.pool.query<{ repo_full_name: string; archetype_signals: Record<string, boolean> | null }>(
            `SELECT repo_full_name, archetype_signals
               FROM repo_sync_state
              WHERE user_id = $1 AND archetype_signals IS NOT NULL`,
            [userId],
        );
        const map = new Map<string, Record<string, boolean>>();
        for (const r of rows) {
            if (r.archetype_signals) map.set(r.repo_full_name, r.archetype_signals);
        }
        return map;
    }

    /**
     * Load `succeeds` relationships as a predecessor -> successors map.
     * A row `(from=aws_eks, to=self_hosted_kubernetes, kind='succeeds')` means
     * "aws_eks SUCCEEDS self_hosted_kubernetes" (the newer tech replaces the older).
     * The map keys the OLDER (predecessor) canonical to its newer successors, so a
     * doc claim about the predecessor can be flagged stale when a successor is the
     * code truth. Empty map when none seeded.
     */
    async loadSucceedsEdges(): Promise<Map<string, Set<string>>> {
        const { rows } = await this.pool.query<{ predecessor: string; successor: string }>(
            `SELECT lower(t.canonical_name) AS predecessor, lower(f.canonical_name) AS successor
               FROM technology_relationships r
               JOIN technology_ontology f ON f.id = r.from_id
               JOIN technology_ontology t ON t.id = r.to_id
              WHERE r.kind = 'succeeds'`,
        );
        const map = new Map<string, Set<string>>();
        for (const r of rows) {
            let set = map.get(r.predecessor);
            if (set === undefined) {
                set = new Set();
                map.set(r.predecessor, set);
            }
            set.add(r.successor);
        }
        return map;
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
