import type { Pool, PoolClient } from 'pg';
import type { IEmbeddingProvider } from '../../rds/interfaces/IEmbeddingProvider.js';

export interface RetrievedPassage {
    text:      string;
    score:     number;
    source:    'profile' | 'chunk';
    sourceUri: string;
    metadata: {
        repo_full_name: string;
        chunk_type?:    string;
        file_path?:     string;
        chunk_index?:   number;
        fileClass?:     string;
        domain?:        string;
        technologies?:  string[];
        /** Repo's dominant source language (profile passages only). */
        primaryLanguage?: string;
        /**
         * Set on chunks pulled in by neighbour expansion rather than by the
         * vector/BM25 hit itself. Value is `<file_path>#<anchor chunk_index>` —
         * the hit whose context this chunk extends.
         */
        neighbourOf?:   string;
    };
}

export interface RetrieveOptions {
    maxProfiles?:       number;
    maxChunks?:         number;
    profileWeight?:     number;
    filterByDomain?:    string;
    filterByTechStack?: string[];
    /**
     * Pull this many chunks either side of each chunk hit from the same file
     * (Graph-RAG-lite: restores cross-chunk context a top-K cut would drop —
     * e.g. the rest of a function split across chunk boundaries). 0 disables.
     * Default: 1.
     */
    neighbourRadius?:   number;
    /**
     * Restrict chunk hits to these `metadata.fileClass` roles
     * (e.g. ['source','iac']). Omit to consider all roles.
     */
    filterByFileClass?: string[];
    /**
     * Per-role score multiplier. Overrides {@link DEFAULT_FILE_CLASS_WEIGHTS}
     * for the named roles; unlisted roles keep their default. Lets a query
     * favour, say, IaC over docs without excluding either.
     */
    fileClassWeights?:  Record<string, number>;
    /**
     * Restrict profile hits to repos whose `repo_sync_state` carries ALL of
     * these signals as true — drawn from either the archetype map
     * (`has_ci`, `has_iac`, `has_dockerfile`, …) or the evidence topology
     * (`has_test_script`, `has_migrations`, …). e.g. ['has_ci','has_iac'].
     */
    filterByRepoSignals?: string[];
    /** Restrict profile hits to repos whose dominant language is in this set. */
    filterByPrimaryLanguage?: string[];
    /**
     * Soft preference: multiply a profile's score by
     * (1 + SIGNAL_BOOST × matchedCount) for repos carrying these signals.
     * Favours, say, repos with real CI + IaC without excluding the rest.
     */
    boostByRepoSignals?: string[];
}

const DEFAULT_MAX_PROFILES    = 5;
const DEFAULT_MAX_CHUNKS      = 5;
const DEFAULT_PROFILE_WEIGHT  = 1.5;
const DEFAULT_NEIGHBOUR_RADIUS = 1;
/** A neighbour ranks just below its anchor so it stays adjacent on merge. */
const NEIGHBOUR_SCORE_DELTA   = 0.001;
/** Score multiplier per matched repo signal for {@link RetrieveOptions.boostByRepoSignals}. */
const SIGNAL_BOOST            = 0.1;

/**
 * Default per-role score multipliers. High-signal evidence (source, IaC, db,
 * commit history) keeps full weight; lower-signal or noisier roles (config,
 * test, raw data) are de-emphasised so they inform but do not crowd out the
 * code that answers "how did you build X". Unlisted roles default to 1.0.
 */
const DEFAULT_FILE_CLASS_WEIGHTS: Record<string, number> = {
    source:  1,
    iac:     1,
    db:      1,
    history: 1,
    docs:    1,
    ci:      0.95,
    script:  0.9,
    config:  0.7,
    test:    0.6,
    data:    0.5,
    other:   0.8,
};

function weightFor(
    fileClass: string | undefined,
    overrides: Record<string, number> | undefined,
): number {
    if (!fileClass) return 1;
    return overrides?.[fileClass] ?? DEFAULT_FILE_CLASS_WEIGHTS[fileClass] ?? 1;
}

export class PgVectorRetriever {
    constructor(
        private readonly pool:    Pool,
        private readonly embedder: IEmbeddingProvider,
    ) {}

    async retrieve(
        userId:  string,
        query:   string,
        options: RetrieveOptions = {},
    ): Promise<RetrievedPassage[]> {
        const {
            maxProfiles     = DEFAULT_MAX_PROFILES,
            maxChunks       = DEFAULT_MAX_CHUNKS,
            profileWeight   = DEFAULT_PROFILE_WEIGHT,
            neighbourRadius = DEFAULT_NEIGHBOUR_RADIUS,
            filterByDomain,
            filterByTechStack,
            filterByFileClass,
            fileClassWeights,
            filterByRepoSignals,
            filterByPrimaryLanguage,
            boostByRepoSignals,
        } = options;

        const embedding = await this.embedder.embed(query);
        const vectorStr = `[${embedding.join(',')}]`;

        const [profilePassages, chunkPassages] = await Promise.all([
            this.queryProfileLayer(userId, vectorStr, maxProfiles, profileWeight, {
                filterByDomain, filterByTechStack, filterByRepoSignals, filterByPrimaryLanguage, boostByRepoSignals,
            }),
            this.queryChunkLayer(userId, vectorStr, query, maxChunks, neighbourRadius, filterByFileClass, fileClassWeights),
        ]);

        return [...profilePassages, ...chunkPassages].sort((a, b) => b.score - a.score);
    }

    private async queryProfileLayer(
        userId:        string,
        vectorStr:     string,
        limit:         number,
        profileWeight: number,
        filters:       ProfileFilters,
    ): Promise<RetrievedPassage[]> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);

            const params: unknown[] = [userId, vectorStr, profileWeight, limit];
            const filterSql = buildProfileFilters(params, filters);

            const result = await client.query<ProfileRow>(
                // LEFT JOIN repo_sync_state surfaces the per-repo archetype signals
                // and evidence topology (incl. primary language) so retrieval can
                // filter/boost by them — the signals that were previously derived
                // post-ingestion but never reached a query.
                `SELECT
                    e.content,
                    e.chunk_type,
                    e.metadata,
                    p.repo_full_name,
                    p.extracted->>'domain'    AS domain,
                    p.extracted->'tech_stack' AS tech_stack,
                    s.archetype_signals,
                    s.evidence_topology,
                    s.evidence_topology->>'primary_language' AS primary_language,
                    (1 - (e.embedding <=> $2::vector)) * $3 AS score
                 FROM repository_profile_embeddings e
                 JOIN repository_profiles p ON p.id = e.profile_id
                 LEFT JOIN repo_sync_state s
                        ON s.user_id = e.user_id AND s.repo_full_name = p.repo_full_name
                WHERE e.user_id = $1::uuid
                  ${filterSql}
                ORDER BY e.embedding <=> $2::vector
                LIMIT $4`,
                params,
            );

            await client.query('COMMIT');

            const boostKeys = filters.boostByRepoSignals;
            return result.rows.map((row) => {
                const matched = boostKeys ? countMatchedSignals(row, boostKeys) : 0;
                return {
                    text:      row.content,
                    score:     Number(row.score) * (1 + SIGNAL_BOOST * matched),
                    source:    'profile' as const,
                    sourceUri: row.repo_full_name,
                    metadata: {
                        repo_full_name:  row.repo_full_name,
                        chunk_type:      row.chunk_type ?? undefined,
                        domain:          row.domain ?? undefined,
                        technologies:    row.tech_stack ?? undefined,
                        primaryLanguage: row.primary_language ?? undefined,
                    },
                };
            });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    private async queryChunkLayer(
        userId:            string,
        vectorStr:         string,
        queryText:         string,
        limit:             number,
        neighbourRadius:   number,
        filterByFileClass?: string[],
        fileClassWeights?:  Record<string, number>,
    ): Promise<RetrievedPassage[]> {
        // Fuse a wider candidate pool (vector + BM25) via Reciprocal Rank Fusion,
        // then cut to `limit`. RRF picks WHICH chunks return (recall); the reported
        // score stays cosine so chunk/profile layers remain comparable on merge.
        // BM25 (content_tsv) is empty-query tolerant: a non-matching plainto_tsquery
        // yields no text rows, so it degrades to pure vector — never worse.
        const candidatePool = Math.min(limit * 4, 50);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);

            const result = await client.query<{
                content:        string;
                repo_full_name: string;
                file_path:      string;
                chunk_index:    number | null;
                metadata:       Record<string, unknown>;
                score:          number | string;
            }>(
                // $6 (nullable text[]) optionally restricts both candidate CTEs to
                // the requested fileClass roles before fusion.
                `WITH vector_ranked AS (
                    SELECT d.id, ROW_NUMBER() OVER (ORDER BY d.embedding <=> $2::vector) AS vrank
                    FROM document_embeddings d
                    WHERE d.user_id = $1::uuid
                      AND ($6::text[] IS NULL OR d.metadata->>'fileClass' = ANY($6))
                    ORDER BY d.embedding <=> $2::vector
                    LIMIT $4
                ),
                text_ranked AS (
                    SELECT d.id, ROW_NUMBER() OVER (
                        ORDER BY ts_rank(d.content_tsv, plainto_tsquery('english', $3)) DESC
                    ) AS trank
                    FROM document_embeddings d
                    WHERE d.user_id = $1::uuid
                      AND d.content_tsv @@ plainto_tsquery('english', $3)
                      AND ($6::text[] IS NULL OR d.metadata->>'fileClass' = ANY($6))
                    ORDER BY ts_rank(d.content_tsv, plainto_tsquery('english', $3)) DESC
                    LIMIT $4
                ),
                rrf AS (
                    SELECT COALESCE(v.id, t.id) AS id,
                           COALESCE(1.0 / (60 + v.vrank), 0.0)
                             + COALESCE(1.0 / (60 + t.trank), 0.0) AS rrf_score
                    FROM vector_ranked v
                    FULL OUTER JOIN text_ranked t ON v.id = t.id
                )
                SELECT
                    d.content,
                    d.repo_full_name,
                    d.file_path,
                    d.chunk_index,
                    d.metadata,
                    1 - (d.embedding <=> $2::vector) AS score
                 FROM rrf r
                 JOIN document_embeddings d ON d.id = r.id
                ORDER BY r.rrf_score DESC
                LIMIT $5`,
                [userId, vectorStr, queryText, candidatePool, limit, filterByFileClass ?? null],
            );

            const primary: RetrievedPassage[] = result.rows.map((row) => {
                const rawClass = row.metadata?.['fileClass'];
                const fileClass = typeof rawClass === 'string' ? rawClass : undefined;
                return {
                    text:      row.content,
                    // Role weighting: multiply cosine by the class weight so
                    // low-signal roles inform without crowding out source/IaC.
                    score:     Number(row.score) * weightFor(fileClass, fileClassWeights),
                    source:    'chunk' as const,
                    sourceUri: row.file_path,
                    metadata: {
                        repo_full_name: row.repo_full_name,
                        file_path:      row.file_path,
                        chunk_index:    row.chunk_index ?? undefined,
                        fileClass,
                    },
                };
            });

            const neighbours =
                neighbourRadius > 0
                    ? await this.fetchNeighbours(client, userId, primary, neighbourRadius)
                    : [];

            await client.query('COMMIT');

            return [...primary, ...neighbours];
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Pull chunks within `radius` of each chunk hit from the same file, in the
     * same RLS-scoped transaction. A neighbour inherits its anchor's score minus
     * a small delta so it sorts immediately after the anchor rather than
     * competing on its own (possibly low) similarity. Chunks already returned as
     * primary hits are not duplicated.
     */
    private async fetchNeighbours(
        client:  PoolClient,
        userId:  string,
        primary: RetrievedPassage[],
        radius:  number,
    ): Promise<RetrievedPassage[]> {
        const anchors = toAnchors(primary);
        if (anchors.length === 0) return [];

        const res = await client.query<{
            content:        string;
            repo_full_name: string;
            file_path:      string;
            chunk_index:    number;
            metadata:       Record<string, unknown>;
        }>(
            `SELECT d.content, d.repo_full_name, d.file_path, d.chunk_index, d.metadata
               FROM document_embeddings d
               JOIN unnest($2::text[], $3::text[], $4::int[], $5::int[])
                    AS a(repo, file, lo, hi)
                 ON d.repo_full_name = a.repo
                AND d.file_path      = a.file
                AND d.chunk_index BETWEEN a.lo AND a.hi
              WHERE d.user_id = $1::uuid`,
            [
                userId,
                anchors.map((a) => a.repo),
                anchors.map((a) => a.file),
                anchors.map((a) => a.idx - radius),
                anchors.map((a) => a.idx + radius),
            ],
        );

        const taken = new Set(anchors.map((a) => keyOf(a.repo, a.file, a.idx)));
        const out: RetrievedPassage[] = [];
        for (const row of res.rows) {
            const key = keyOf(row.repo_full_name, row.file_path, row.chunk_index);
            if (taken.has(key)) continue;
            taken.add(key);

            const anchor = nearestAnchor(anchors, row.repo_full_name, row.file_path, row.chunk_index);
            if (!anchor) continue;

            out.push({
                text:      row.content,
                score:     anchor.score - NEIGHBOUR_SCORE_DELTA,
                source:    'chunk',
                sourceUri: row.file_path,
                metadata: {
                    repo_full_name: row.repo_full_name,
                    file_path:      row.file_path,
                    chunk_index:    row.chunk_index,
                    neighbourOf:    `${row.file_path}#${anchor.idx}`,
                },
            });
        }
        return out;
    }
}

/** Filters/boosts applied to the profile layer. */
interface ProfileFilters {
    filterByDomain?:          string;
    filterByTechStack?:       string[];
    filterByRepoSignals?:     string[];
    filterByPrimaryLanguage?: string[];
    boostByRepoSignals?:      string[];
}

interface ProfileRow {
    content:           string;
    chunk_type:        string | null;
    metadata:          Record<string, unknown>;
    repo_full_name:    string;
    domain:            string | null;
    tech_stack:        string[] | null;
    archetype_signals: Record<string, unknown> | null;
    evidence_topology: Record<string, unknown> | null;
    primary_language:  string | null;
    score:             number | string;
}

/**
 * Append profile-layer filter SQL, pushing bind params. Repo-signal filtering
 * requires every requested key to be true in EITHER the archetype map or the
 * evidence topology (the two jsonb columns that hold them).
 */
function buildProfileFilters(params: unknown[], filters: ProfileFilters): string {
    const clauses: string[] = [];
    if (filters.filterByDomain) {
        params.push(filters.filterByDomain);
        clauses.push(`AND p.extracted->>'domain' = $${params.length}`);
    }
    if (filters.filterByTechStack?.length) {
        params.push(JSON.stringify(filters.filterByTechStack));
        clauses.push(`AND p.extracted->'tech_stack' @> $${params.length}::jsonb`);
    }
    if (filters.filterByRepoSignals?.length) {
        params.push(filters.filterByRepoSignals);
        clauses.push(
            `AND NOT EXISTS (
                SELECT 1 FROM unnest($${params.length}::text[]) AS k
                WHERE COALESCE(s.archetype_signals->>k, 'false') <> 'true'
                  AND COALESCE(s.evidence_topology->>k, 'false') <> 'true'
            )`,
        );
    }
    if (filters.filterByPrimaryLanguage?.length) {
        params.push(filters.filterByPrimaryLanguage);
        clauses.push(`AND s.evidence_topology->>'primary_language' = ANY($${params.length})`);
    }
    return clauses.join('\n                  ');
}

/** A signal is "on" when it is true (or the string 'true') in either jsonb map. */
function signalIsOn(row: ProfileRow, key: string): boolean {
    const a = row.archetype_signals?.[key];
    const t = row.evidence_topology?.[key];
    return a === true || a === 'true' || t === true || t === 'true';
}

function countMatchedSignals(row: ProfileRow, keys: string[]): number {
    return keys.reduce((n, k) => n + (signalIsOn(row, k) ? 1 : 0), 0);
}

/** A chunk hit usable as a centre point for neighbour expansion. */
interface Anchor {
    repo:  string;
    file:  string;
    idx:   number;
    score: number;
}

function keyOf(repo: string, file: string, idx: number): string {
    return `${repo}|${file}|${idx}`;
}

/** Chunk hits with a concrete file path and integer chunk_index. */
function toAnchors(passages: RetrievedPassage[]): Anchor[] {
    const out: Anchor[] = [];
    for (const p of passages) {
        const idx = p.metadata.chunk_index;
        if (p.metadata.file_path && Number.isInteger(idx)) {
            out.push({ repo: p.metadata.repo_full_name, file: p.metadata.file_path, idx: idx as number, score: p.score });
        }
    }
    return out;
}

/** The closest anchor in the same file, or null if none. */
function nearestAnchor(anchors: Anchor[], repo: string, file: string, idx: number): Anchor | null {
    let best: Anchor | null = null;
    for (const a of anchors) {
        if (a.repo !== repo || a.file !== file) continue;
        if (best === null || Math.abs(a.idx - idx) < Math.abs(best.idx - idx)) best = a;
    }
    return best;
}
