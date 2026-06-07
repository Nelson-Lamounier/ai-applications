/** @format */
import { Pool } from 'pg';
import type { QueryParams, SimilarityResult } from '../types.js';
import type { RdsClientConfig } from './RdsVectorStore.js';

interface ExperienceRow {
    id: string;
    chunk_type: string;
    content: string;
    similarity: number;
}

/**
 * Read-only vector retriever over `experience_embeddings` (résumé Career Data).
 * Mirrors RdsVectorStore.querySimilar's return type so the Research agent can
 * treat repo-KB and career evidence uniformly. Vector-only: experience_embeddings
 * has no content_tsv, so `useHybrid` is ignored.
 */
export class RdsExperienceVectorStore {
    private readonly pool: Pool;

    constructor(config: RdsClientConfig, pool?: Pool) {
        this.pool = pool ?? new Pool({
            host: config.host, port: config.port, database: config.database,
            user: config.user, password: config.password,
            max: 5, idleTimeoutMillis: 30_000, ssl: false,
        });
    }

    static fromEnvironment(): RdsExperienceVectorStore {
        const host = process.env.RDS_HOST, port = process.env.RDS_PORT,
            database = process.env.RDS_DB_NAME, user = process.env.RDS_USER,
            password = process.env.RDS_PASSWORD;
        if (!host || !port || !database || !user || !password) {
            throw new Error('RdsExperienceVectorStore: missing env. Required: RDS_HOST, RDS_PORT, RDS_DB_NAME, RDS_USER, RDS_PASSWORD');
        }
        return new RdsExperienceVectorStore({ host, port: parseInt(port, 10), database, user, password });
    }

    async querySimilar(params: QueryParams): Promise<SimilarityResult[]> {
        const limit = params.limit ?? 40;
        const r = await this.pool.query<ExperienceRow>(
            `SELECT id, chunk_type, content,
                    1 - (embedding <=> $2::vector) AS similarity
               FROM experience_embeddings
              WHERE user_id = $1
              ORDER BY embedding <=> $2::vector
              LIMIT $3`,
            [params.userId, JSON.stringify(params.queryEmbedding), limit],
        );
        return r.rows.map(row => ({
            id: row.id,
            repoFullName: 'career',
            filePath: row.chunk_type,
            heading: null,
            content: row.content,
            chunkIndex: 0,
            tags: [],
            similarity: Number(row.similarity),
            cosine: Number(row.similarity),
        }));
    }
}
