/** @format */
import type { Pool } from 'pg';

export interface RepoFileEntry {
    readonly path:      string;
    readonly blobSha:   string;
    readonly sizeBytes: number;
}

export class RdsRepoFileStateRepository {
    constructor(private readonly pool: Pool) {}

    async getFileState(userId: string, repoFullName: string): Promise<Map<string, string>> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            const { rows } = await client.query<{ file_path: string; blob_sha: string }>(
                `SELECT file_path, blob_sha FROM repo_file_state
                  WHERE user_id = $1 AND repo_full_name = $2`,
                [userId, repoFullName],
            );
            await client.query('COMMIT');
            return new Map(rows.map(r => [r.file_path, r.blob_sha]));
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async upsertFileState(userId: string, repoFullName: string, files: readonly RepoFileEntry[]): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            await client.query(
                `DELETE FROM repo_file_state WHERE user_id = $1 AND repo_full_name = $2`,
                [userId, repoFullName],
            );
            if (files.length > 0) {
                const placeholders = files.map((_, i) => {
                    const b = i * 5;
                    return `($${b + 1}::uuid, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::int)`;
                }).join(', ');
                const values: unknown[] = [];
                for (const f of files) values.push(userId, repoFullName, f.path, f.blobSha, f.sizeBytes);
                await client.query(
                    `INSERT INTO repo_file_state
                        (user_id, repo_full_name, file_path, blob_sha, size_bytes)
                     VALUES ${placeholders}`,
                    values,
                );
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async deleteFileState(userId: string, repoFullName: string): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
            await client.query(
                `DELETE FROM repo_file_state WHERE user_id = $1 AND repo_full_name = $2`,
                [userId, repoFullName],
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
