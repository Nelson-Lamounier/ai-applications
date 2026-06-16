import type { Pool } from 'pg';
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
        domain?:        string;
        technologies?:  string[];
    };
}

export interface RetrieveOptions {
    maxProfiles?:       number;
    maxChunks?:         number;
    profileWeight?:     number;
    filterByDomain?:    string;
    filterByTechStack?: string[];
}

const DEFAULT_MAX_PROFILES   = 5;
const DEFAULT_MAX_CHUNKS     = 5;
const DEFAULT_PROFILE_WEIGHT = 1.5;

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
            maxProfiles   = DEFAULT_MAX_PROFILES,
            maxChunks     = DEFAULT_MAX_CHUNKS,
            profileWeight = DEFAULT_PROFILE_WEIGHT,
            filterByDomain,
            filterByTechStack,
        } = options;

        const embedding = await this.embedder.embed(query);
        const vectorStr = `[${embedding.join(',')}]`;

        const [profilePassages, chunkPassages] = await Promise.all([
            this.queryProfileLayer(userId, vectorStr, maxProfiles, profileWeight, filterByDomain, filterByTechStack),
            this.queryChunkLayer(userId, vectorStr, query, maxChunks),
        ]);

        return [...profilePassages, ...chunkPassages].sort((a, b) => b.score - a.score);
    }

    private async queryProfileLayer(
        userId:             string,
        vectorStr:          string,
        limit:              number,
        profileWeight:      number,
        filterByDomain?:    string,
        filterByTechStack?: string[],
    ): Promise<RetrievedPassage[]> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SET LOCAL app.current_user_id = $1`, [userId]);

            const params: unknown[] = [userId, vectorStr, profileWeight, limit];
            let domainFilter    = '';
            let techStackFilter = '';

            if (filterByDomain) {
                params.push(filterByDomain);
                domainFilter = `AND p.extracted->>'domain' = $${params.length}`;
            }
            if (filterByTechStack && filterByTechStack.length > 0) {
                params.push(JSON.stringify(filterByTechStack));
                techStackFilter = `AND p.extracted->'tech_stack' @> $${params.length}::jsonb`;
            }

            const result = await client.query<{
                content:        string;
                chunk_type:     string | null;
                metadata:       Record<string, unknown>;
                repo_full_name: string;
                domain:         string | null;
                tech_stack:     string[] | null;
                score:          number | string;
            }>(
                `SELECT
                    e.content,
                    e.chunk_type,
                    e.metadata,
                    p.repo_full_name,
                    p.extracted->>'domain'    AS domain,
                    p.extracted->'tech_stack' AS tech_stack,
                    (1 - (e.embedding <=> $2::vector)) * $3 AS score
                 FROM repository_profile_embeddings e
                 JOIN repository_profiles p ON p.id = e.profile_id
                WHERE e.user_id = $1::uuid
                  ${domainFilter}
                  ${techStackFilter}
                ORDER BY e.embedding <=> $2::vector
                LIMIT $4`,
                params,
            );

            await client.query('COMMIT');

            return result.rows.map((row) => ({
                text:      row.content,
                score:     Number(row.score),
                source:    'profile' as const,
                sourceUri: row.repo_full_name,
                metadata: {
                    repo_full_name: row.repo_full_name,
                    chunk_type:     row.chunk_type ?? undefined,
                    domain:         row.domain ?? undefined,
                    technologies:   row.tech_stack ?? undefined,
                },
            }));
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    private async queryChunkLayer(
        userId:    string,
        vectorStr: string,
        queryText: string,
        limit:     number,
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
            await client.query(`SET LOCAL app.current_user_id = $1`, [userId]);

            const result = await client.query<{
                content:        string;
                repo_full_name: string;
                file_path:      string;
                metadata:       Record<string, unknown>;
                score:          number | string;
            }>(
                `WITH vector_ranked AS (
                    SELECT d.id, ROW_NUMBER() OVER (ORDER BY d.embedding <=> $2::vector) AS vrank
                    FROM document_embeddings d
                    WHERE d.user_id = $1::uuid
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
                    d.metadata,
                    1 - (d.embedding <=> $2::vector) AS score
                 FROM rrf r
                 JOIN document_embeddings d ON d.id = r.id
                ORDER BY r.rrf_score DESC
                LIMIT $5`,
                [userId, vectorStr, queryText, candidatePool, limit],
            );

            await client.query('COMMIT');

            return result.rows.map((row) => ({
                text:      row.content,
                score:     Number(row.score),
                source:    'chunk' as const,
                sourceUri: row.file_path,
                metadata: {
                    repo_full_name: row.repo_full_name,
                    file_path:      row.file_path,
                },
            }));
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
}
