/** @format */
import type { Pool } from 'pg';

/**
 * One aggregated `concept_evidence` row (migration 123): a JD-evidenced
 * "concept" (CI/CD, observability, distributed systems, ...) detected in one
 * of a user's repos, resolved to its `skill_ontology` canonical name and
 * grouped by (canonical, repo, detector) with a file count.
 */
export interface RepoConceptRow {
    readonly canonicalName: string;
    readonly repoFullName: string;
    readonly detector: string;
    readonly files: number;
}

/**
 * Reads the global skill ontology + aliases (migration 092). The deterministic
 * counterpart to TechnologyOntologyRepository — resolves the free-text `skills`
 * the LLM enricher emits to canonical skills, collapsing variance like
 * "k8s networking" ≈ "kubernetes networking".
 *
 * The ontology/alias tables themselves are reference data (not user-scoped, no
 * RLS / set_config needed); `loadRepoConcepts` below is the one per-user
 * evidence exception, mirroring `TechnologyOntologyRepository.loadRepoCodeTech`
 * — same idiom, different evidence table (`concept_evidence`, not
 * `technology_evidence`), so it lives alongside the ontology it resolves
 * against rather than bloating the tech-only repository. Built once per Job
 * and handed to the generic OntologyResolver (Map<alias,id>).
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
     * Load the active canonical skill names (lowercased) — the CONTROLLED
     * VOCABULARY for controlled-vocab enrichment (feature: the vocabulary fix).
     * The SAME vocabulary the JD extractor canonicalises into, so corpus + query
     * speak one language and `d.skills && query.skills` overlaps. Grows with the
     * application's JD/repo usage (proprietary), so this is read fresh per Job.
     */
    async loadCanonicalNames(): Promise<string[]> {
        const { rows } = await this.pool.query<{ canonical_name: string }>(
            `SELECT canonical_name FROM skill_ontology WHERE is_active ORDER BY canonical_name`,
        );
        return rows.map((r) => r.canonical_name.toLowerCase());
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

    /**
     * Load active canonicals + their embeddings (parsed from the pgvector text
     * form) for near-duplicate detection (dedupeSkillCanonicals). Skips rows not
     * yet embedded. Carries curation_level so the merge keeps the curated row.
     */
    async loadActiveWithEmbeddings(): Promise<Array<{ id: string; canonical: string; curationLevel: string; embedding: number[] }>> {
        const { rows } = await this.pool.query<{ id: string; canonical_name: string; curation_level: string; embedding: string }>(
            `SELECT id, canonical_name, curation_level, embedding::text AS embedding
               FROM skill_ontology
              WHERE is_active = true AND embedding IS NOT NULL`,
        );
        return rows.map((r) => ({
            id: r.id,
            canonical: r.canonical_name,
            curationLevel: r.curation_level,
            embedding: r.embedding.replace(/[[\]]/g, '').split(',').map(Number),
        }));
    }

    /**
     * Load a user's concept-evidence rows, aggregated by (canonical, repo,
     * detector) — the deterministic detector-backed facts from
     * `concept_evidence` (migration 123), resolved to ontology canonical
     * names. `concept_evidence` is user-scoped and RLS-enabled; the explicit
     * `user_id = $1` filter mirrors `TechnologyOntologyRepository`'s per-user
     * evidence loaders (e.g. `loadRepoCodeTech`) — the connecting role reads
     * across the filter, same convention.
     *
     * Empty array when no concept evidence exists (callers fail-open).
     */
    async loadRepoConcepts(userId: string): Promise<RepoConceptRow[]> {
        const { rows } = await this.pool.query<{
            canonical_name: string;
            repo_full_name: string;
            detector: string;
            files: number;
        }>(
            `SELECT so.canonical_name, ce.repo_full_name, ce.detector, count(*)::int AS files
               FROM concept_evidence ce
               JOIN skill_ontology so ON so.id = ce.skill_id
              WHERE ce.user_id = $1
              GROUP BY 1, 2, 3`,
            [userId],
        );
        return rows.map((r) => ({
            canonicalName: r.canonical_name.toLowerCase(),
            repoFullName:  r.repo_full_name,
            detector:      r.detector,
            files:         r.files,
        }));
    }
}
