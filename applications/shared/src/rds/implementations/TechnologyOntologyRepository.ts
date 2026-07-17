/** @format */
import type { Pool } from 'pg';

/** How completely a transfer group's skills substitute for one another (migration 120). */
export type TransferTier = 'full' | 'partial';

/**
 * One group of mutually-transferable canonical tech names.
 *
 * Two different construction methods feed `loadTransferGroups()`, and they
 * are NOT the same kind of grouping:
 *  - TYPED groups (`transferClass` non-null) are built by grouping edges
 *    whose `transfer_class` is set (migration 120) BY CLASS — one group per
 *    class, membership is every canonical touched by that class's edges.
 *    Migration 120 seeds each class as a full pairwise graph, so grouping by
 *    class and grouping by connectivity agree for typed edges alone.
 *  - UNTYPED groups (`transferClass` null) are connected components over the
 *    remaining untyped edges (legacy `related_to` rows predating 120, or
 *    structural edges like `part_of` that were never meant to carry a
 *    transfer class). Connectivity, not class, is the only signal available.
 *
 * Deriving typed groups from connectivity (the old behaviour) was wrong on
 * live data: a stray untyped edge (e.g. `aws_bedrock part_of aws`) would
 * bridge a typed class into an unrelated component and either mislabel it or
 * absorb it wholesale. Grouping typed edges by class instead of by
 * connectivity fixes that — see `loadTransferGroups()`.
 *
 * `loadCategoryGroups()` groups have no relationship edges backing them, so
 * all three metadata fields are always `null` there too.
 *
 * A canonical can legitimately appear in both a typed group and an untyped
 * group (e.g. `aws_bedrock` in the typed `ai-provider` class AND the untyped
 * `aws`-rooted component via `part_of`) — callers that render one line per
 * matching group must decide how to avoid a redundant echo (see
 * `formatTechTransferContext` in job-strategist for the documented rule).
 */
export interface TechTransferGroup {
    readonly members: string[];
    readonly transferClass: string | null;
    readonly transferTier: TransferTier | null;
    readonly transferBasis: string | null;
}

/** One `technology_relationships` edge, node names lowercased, typed metadata as read (may be null). */
interface TransferEdge {
    readonly from: string;
    readonly to: string;
    readonly transferClass: string | null;
    readonly transferTier: TransferTier | null;
    readonly transferBasis: string | null;
}

/** Build an undirected adjacency map from a lowercased edge list. */
function buildAdjacency(edges: readonly TransferEdge[]): Map<string, Set<string>> {
    const adj = new Map<string, Set<string>>();
    for (const { from, to } of edges) {
        if (!adj.has(from)) adj.set(from, new Set());
        if (!adj.has(to)) adj.set(to, new Set());
        (adj.get(from) as Set<string>).add(to);
        (adj.get(to) as Set<string>).add(from);
    }
    return adj;
}

/**
 * Non-recursive BFS over an adjacency map. Returns each connected component
 * of ≥2 nodes (singletons give no transfer signal and are dropped).
 */
function findConnectedComponents(adj: ReadonlyMap<string, Set<string>>): string[][] {
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
            for (const neighbour of adj.get(current) ?? []) {
                if (!visited.has(neighbour)) {
                    visited.add(neighbour);
                    queue.push(neighbour);
                }
            }
        }
        if (component.length >= 2) components.push(component);
    }
    return components;
}

/** Per-class accumulator used by `buildTypedGroups`. */
interface TypedClassBucket {
    members: string[];
    seen: Set<string>;
    transferTier: TransferTier | null;
    transferBasis: string | null;
    warnedTier: boolean;
    warnedBasis: boolean;
}

/** Record both endpoints of `edge` into `bucket.members` (first-appearance order, deduped). */
function addBucketMembers(bucket: TypedClassBucket, edge: TransferEdge): void {
    for (const name of [edge.from, edge.to]) {
        if (!bucket.seen.has(name)) {
            bucket.seen.add(name);
            bucket.members.push(name);
        }
    }
}

/**
 * Take the first non-null `transfer_tier` seen for the class; warn once
 * (per class) if a later edge in the same class disagrees.
 */
function recordBucketTier(bucket: TypedClassBucket, edge: TransferEdge): void {
    if (edge.transferTier === null) return;
    if (bucket.transferTier === null) {
        bucket.transferTier = edge.transferTier;
    } else if (edge.transferTier !== bucket.transferTier && !bucket.warnedTier) {
        console.warn(
            `TechnologyOntologyRepository.loadTransferGroups: transfer_class '${edge.transferClass}' has conflicting transfer_tier values ('${bucket.transferTier}' vs '${edge.transferTier}') -- keeping the first`,
        );
        bucket.warnedTier = true;
    }
}

/**
 * Take the first non-null `transfer_basis` seen for the class; warn once
 * (per class) if a later edge in the same class disagrees.
 */
function recordBucketBasis(bucket: TypedClassBucket, edge: TransferEdge): void {
    if (edge.transferBasis === null) return;
    if (bucket.transferBasis === null) {
        bucket.transferBasis = edge.transferBasis;
    } else if (edge.transferBasis !== bucket.transferBasis && !bucket.warnedBasis) {
        console.warn(
            `TechnologyOntologyRepository.loadTransferGroups: transfer_class '${edge.transferClass}' has conflicting transfer_basis values -- keeping the first`,
        );
        bucket.warnedBasis = true;
    }
}

/**
 * Build one `TechTransferGroup` per distinct `transfer_class` found among
 * TYPED edges (`transfer_class IS NOT NULL`) — the fix for the mislabelling
 * bug: grouping by class instead of by connectivity means a stray untyped
 * edge elsewhere in the graph can never merge two classes or pull an
 * unrelated component into one.
 *
 * `members` is every canonical touched by that class's edges, lowercased,
 * in first-appearance (insertion) order — deterministic because callers
 * pass edges pre-sorted `ORDER BY transfer_class, from_id, to_id`.
 *
 * `transferTier`/`transferBasis` take the first NON-NULL value seen for the
 * class (deterministic given the same ordering). A later edge in the same
 * class disagreeing with that first value is a data inconsistency — 120
 * seeds one tier/basis per class — so it is kept as the winner and a
 * warning is logged once per class per field, surfacing the issue without
 * failing the read.
 */
function buildTypedGroups(edges: readonly TransferEdge[]): TechTransferGroup[] {
    const byClass = new Map<string, TypedClassBucket>();
    for (const edge of edges) {
        if (edge.transferClass === null) continue;
        let bucket = byClass.get(edge.transferClass);
        if (bucket === undefined) {
            bucket = { members: [], seen: new Set(), transferTier: null, transferBasis: null, warnedTier: false, warnedBasis: false };
            byClass.set(edge.transferClass, bucket);
        }
        addBucketMembers(bucket, edge);
        recordBucketTier(bucket, edge);
        recordBucketBasis(bucket, edge);
    }
    return [...byClass.entries()].map(([transferClass, bucket]) => ({
        members: bucket.members,
        transferClass,
        transferTier: bucket.transferTier,
        transferBasis: bucket.transferBasis,
    }));
}

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
            // Two sources of (canonical → file) proof, UNIONed:
            //  1. Library/framework tech tagged by the ontology (existing behaviour).
            //  2. The file's LANGUAGE by extension — a .py file proves Python even when its
            //     ontology tag is a library (cdk-monitoring's Checkov rule .py files were tagged
            //     'checkov', so 'python' got 0 of them despite 109 .py files). Same code source
            //     layers, so a language skill cites real source files, not just config/CI mentions.
            `SELECT canonical, path FROM (
               SELECT lower(o.canonical_name) AS canonical,
                      te.repo_full_name || '/' || te.file_path AS path
                 FROM technology_evidence te
                 JOIN technology_ontology o ON o.id = te.technology_id
                WHERE te.user_id = $1
                  AND te.source_layer IN ('syft', 'treesitter', 'iac', 'dockerfile')
               UNION
               SELECT CASE
                        WHEN te.file_path ILIKE '%.py'                               THEN 'python'
                        WHEN te.file_path ILIKE '%.ts' OR te.file_path ILIKE '%.tsx' THEN 'typescript'
                        WHEN te.file_path ILIKE '%.js' OR te.file_path ILIKE '%.jsx'
                          OR te.file_path ILIKE '%.mjs'                              THEN 'javascript'
                        WHEN te.file_path ILIKE '%.go'                               THEN 'go'
                        WHEN te.file_path ILIKE '%.rs'                               THEN 'rust'
                        WHEN te.file_path ILIKE '%.java'                             THEN 'java'
                        WHEN te.file_path ILIKE '%.rb'                               THEN 'ruby'
                        WHEN te.file_path ILIKE '%.sh' OR te.file_path ILIKE '%.bash' THEN 'bash'
                      END AS canonical,
                      te.repo_full_name || '/' || te.file_path AS path
                 FROM technology_evidence te
                WHERE te.user_id = $1
                  AND te.source_layer IN ('syft', 'treesitter', 'iac', 'dockerfile')
                  AND (te.file_path ILIKE '%.py'  OR te.file_path ILIKE '%.ts'  OR te.file_path ILIKE '%.tsx'
                    OR te.file_path ILIKE '%.js'  OR te.file_path ILIKE '%.jsx' OR te.file_path ILIKE '%.mjs'
                    OR te.file_path ILIKE '%.go'  OR te.file_path ILIKE '%.rs'  OR te.file_path ILIKE '%.java'
                    OR te.file_path ILIKE '%.rb'  OR te.file_path ILIKE '%.sh'  OR te.file_path ILIKE '%.bash')
             ) u
             WHERE canonical IS NOT NULL
             GROUP BY canonical, path
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
     * Used as a fallback when the relationships graph is empty. Category
     * groups have no backing relationship edges, so the typed metadata
     * fields are always `null`.
     */
    async loadCategoryGroups(): Promise<TechTransferGroup[]> {
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
        const groups: TechTransferGroup[] = [];
        for (const members of byCategory.values()) {
            if (members.length >= 2) {
                groups.push({ members, transferClass: null, transferTier: null, transferBasis: null });
            }
        }
        return groups;
    }

    /**
     * Load transfer groups from the technology_relationships graph — TWO
     * different constructions over TWO different edge sets (see the
     * `TechTransferGroup` doc comment for why they must not be mixed):
     *
     *  - TYPED edges (`transfer_class IS NOT NULL`, migration 120) are
     *    grouped BY CLASS (`buildTypedGroups`) — one group per class,
     *    membership is every canonical touched by that class's edges. This
     *    is immune to a stray untyped edge merging or mislabelling a class,
     *    because untyped edges never enter this grouping at all.
     *  - UNTYPED edges (`transfer_class IS NULL` — legacy `related_to` rows
     *    predating 120, or structural edges like `part_of`) are grouped by
     *    graph CONNECTIVITY (`findConnectedComponents`), exactly as before.
     *
     * A canonical can end up in both a typed group and an untyped component
     * — that is correct, not a bug (see the type doc comment).
     *
     * `ORDER BY transfer_class, from_id, to_id` makes both the typed
     * class-grouping and the first-non-null tier/basis resolution
     * deterministic across runs.
     *
     * When the table is empty (no relationships seeded yet) returns [] so
     * the caller can fall back to loadCategoryGroups().
     *
     * Connected-components (untyped edges only) are found with a
     * non-recursive BFS (safe for any realistic ontology size).
     */
    async loadTransferGroups(): Promise<TechTransferGroup[]> {
        const { rows } = await this.pool.query<{
            from_name: string;
            to_name: string;
            transfer_class: string | null;
            transfer_tier: TransferTier | null;
            transfer_basis: string | null;
        }>(
            `SELECT f.canonical_name AS from_name, t.canonical_name AS to_name,
                    r.transfer_class AS transfer_class, r.transfer_tier AS transfer_tier, r.transfer_basis AS transfer_basis
               FROM technology_relationships r
               JOIN technology_ontology f ON f.id = r.from_id
               JOIN technology_ontology t ON t.id = r.to_id
              ORDER BY r.transfer_class, r.from_id, r.to_id`,
        );
        if (rows.length === 0) return [];

        const edges: TransferEdge[] = rows.map((r) => ({
            from: r.from_name.toLowerCase(),
            to: r.to_name.toLowerCase(),
            transferClass: r.transfer_class,
            transferTier: r.transfer_tier,
            transferBasis: r.transfer_basis,
        }));

        const typedEdges = edges.filter((e) => e.transferClass !== null);
        const untypedEdges = edges.filter((e) => e.transferClass === null);

        const typedGroups = buildTypedGroups(typedEdges);
        const untypedComponents = findConnectedComponents(buildAdjacency(untypedEdges));
        const untypedGroups: TechTransferGroup[] = untypedComponents.map((members) => ({
            members,
            transferClass: null,
            transferTier: null,
            transferBasis: null,
        }));

        return [...typedGroups, ...untypedGroups];
    }
}
