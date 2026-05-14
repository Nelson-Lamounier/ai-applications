import type { Pool } from 'pg';

export interface ProfileEmbeddingRow {
    userId:      string;
    profileId:   string;
    chunkType:   'one_liner' | 'description' | 'highlight';
    content:     string;
    contentHash: string;
    embedding:   number[];
    metadata?:   Record<string, unknown>;
}

export class RepositoryProfileEmbeddingsRepository {
    constructor(private readonly pool: Pool) {}

    async upsertBatch(userId: string, rows: ProfileEmbeddingRow[]): Promise<void> {
        if (rows.length === 0) return;

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);

            const valuePlaceholders = rows.map((_, i) => {
                const base = i * 7;
                return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::vector, $${base + 7}::jsonb)`;
            }).join(', ');

            const values: unknown[] = [];
            for (const row of rows) {
                if (row.embedding.some(v => !Number.isFinite(v))) {
                    throw new Error(
                        `Non-finite value in embedding for profileId=${row.profileId} chunkType=${row.chunkType}`,
                    );
                }
                values.push(
                    row.userId,
                    row.profileId,
                    row.chunkType,
                    row.content,
                    row.contentHash,
                    `[${row.embedding.join(',')}]`,
                    JSON.stringify(row.metadata ?? {}),
                );
            }

            await client.query(
                `INSERT INTO repository_profile_embeddings
                    (user_id, profile_id, chunk_type, content, content_hash, embedding, metadata)
                 VALUES ${valuePlaceholders}
                 ON CONFLICT (profile_id, chunk_type, content_hash) DO UPDATE
                     SET embedding      = EXCLUDED.embedding,
                         last_synced_at = now()`,
                values,
            );

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
}
