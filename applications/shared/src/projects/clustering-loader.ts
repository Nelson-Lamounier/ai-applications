/**
 * @format
 * Fetch the inputs the clustering agent needs from RDS.
 *
 * Reads three things, scoped to a single user:
 *
 *   1. Per-repo digests — one row per `repositories` entry, joined to its
 *      `repository_profiles` extracted JSONB for tech stack and
 *      classification.
 *   2. Description embeddings — `repository_profile_embeddings.embedding`
 *      where `chunk_type='description'`. Used for cosine similarity
 *      signals.
 *   3. The IDs already-confirmed projects own — provided by the persistence
 *      layer; this module is the read path.
 *
 * Hot path is small (≤ a few hundred repos per user); we don't paginate.
 */
import type { Pool } from 'pg';

import type { DescriptionEmbedding } from './clustering-signals.js';
import type { RepoClusteringDigest } from './types.js';

interface RepoRow {
    repository_id:     string;
    full_name:         string;
    primary_language:  string | null;
    topics:            string[] | null;
    added_at:          Date | null;
    indexed_at:        Date | null;
    tech_stack:        string[] | null;
    classification:    string | null;
}

interface EmbeddingRow {
    repo_full_name: string;
    embedding:      string; // pgvector returns text by default
}

function shortName(fullName: string): string {
    const idx = fullName.indexOf('/');
    return idx >= 0 ? fullName.slice(idx + 1) : fullName;
}

function parsePgvector(raw: string): number[] {
    // pgvector text format: "[0.1, 0.2, ...]"
    if (!raw || raw.length < 3) return [];
    const inner = raw.slice(1, -1);
    if (!inner) return [];
    const out: number[] = [];
    for (const part of inner.split(',')) {
        const n = Number(part);
        if (Number.isFinite(n)) out.push(n);
    }
    return out;
}

/**
 * Load all repos for a user, with their tech_stack and classification from
 * `repository_profiles` when available. Returns digests in deterministic
 * order (by full_name) so two runs over the same data produce the same
 * prompt input.
 */
export async function loadRepoDigests(
    pool: Pool,
    userId: string,
): Promise<RepoClusteringDigest[]> {
    const r = await pool.query<RepoRow>(
        `SELECT
            r.id                                                 AS repository_id,
            r.full_name                                          AS full_name,
            r.primary_language                                   AS primary_language,
            r.topics                                             AS topics,
            r.added_at                                           AS added_at,
            r.indexed_at                                         AS indexed_at,
            -- repository_profiles.extracted->'tech_stack' is a JSON array of
            -- strings; coerce to text[] for the digest.
            COALESCE(
                ARRAY(
                    SELECT jsonb_array_elements_text(
                        COALESCE(rp.extracted -> 'tech_stack', '[]'::jsonb)
                    )
                ),
                '{}'::text[]
            )                                                    AS tech_stack,
            rp.classification                                    AS classification
         FROM repositories r
         LEFT JOIN repository_profiles rp
           ON rp.user_id = r.user_id AND rp.repo_full_name = r.full_name
         WHERE r.user_id = $1
         ORDER BY r.full_name`,
        [userId],
    );

    return r.rows.map((row) => ({
        repositoryId:    row.repository_id,
        fullName:        row.full_name,
        shortName:       shortName(row.full_name),
        primaryLanguage: row.primary_language,
        topics:          row.topics ?? [],
        firstSeenAt:     row.added_at?.toISOString() ?? null,
        lastSyncedAt:    row.indexed_at?.toISOString() ?? null,
        techStack:       row.tech_stack ?? [],
        classification:  row.classification,
    }));
}

/**
 * Load the description-chunk embeddings for the user's repositories. Repos
 * without a description chunk are simply absent from the result — the
 * cosine-similarity signal skips pairs missing an embedding.
 */
export async function loadDescriptionEmbeddings(
    pool: Pool,
    userId: string,
): Promise<DescriptionEmbedding[]> {
    const r = await pool.query<EmbeddingRow>(
        `SELECT
            rp.repo_full_name           AS repo_full_name,
            rpe.embedding::text         AS embedding
         FROM repository_profile_embeddings rpe
         JOIN repository_profiles rp ON rp.id = rpe.profile_id
         WHERE rpe.user_id = $1
           AND rpe.chunk_type = 'description'`,
        [userId],
    );
    return r.rows.map((row) => ({
        repoFullName: row.repo_full_name,
        embedding:    parsePgvector(row.embedding),
    }));
}
