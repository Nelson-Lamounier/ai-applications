/** @format */
import type { Pool } from 'pg';
import { withUserRls } from '../with-user-rls.js';

export interface RepoFileEntry {
    readonly path:      string;
    readonly blobSha:   string;
    readonly sizeBytes: number;
}

export class RdsRepoFileStateRepository {
    /**
     * @param pool         shared pg Pool
     * @param githubRepoId immutable GitHub numeric repo id, dual-written onto
     *   every repo_file_state insert so a rename heals via metadata update
     *   (reconcileRepoName) rather than a re-ingest. Null on legacy/pre-backfill
     *   runs — the column is nullable.
     */
    constructor(
        private readonly pool: Pool,
        private readonly githubRepoId: number | null = null,
    ) {}

    async getFileState(userId: string, repoFullName: string): Promise<Map<string, string>> {
        return withUserRls(this.pool, userId, async (client) => {
            const { rows } = await client.query<{ file_path: string; blob_sha: string }>(
                `SELECT file_path, blob_sha FROM repo_file_state
                  WHERE user_id = $1 AND repo_full_name = $2`,
                [userId, repoFullName],
            );
            return new Map(rows.map(r => [r.file_path, r.blob_sha]));
        });
    }

    async upsertFileState(userId: string, repoFullName: string, files: readonly RepoFileEntry[]): Promise<void> {
        await withUserRls(this.pool, userId, async (client) => {
            await client.query(
                `DELETE FROM repo_file_state WHERE user_id = $1 AND repo_full_name = $2`,
                [userId, repoFullName],
            );
            if (files.length > 0) {
                const placeholders = files.map((_, i) => {
                    const b = i * 6;
                    return `($${b + 1}::uuid, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}::int, $${b + 6})`;
                }).join(', ');
                const values: unknown[] = [];
                for (const f of files) values.push(userId, repoFullName, f.path, f.blobSha, f.sizeBytes, this.githubRepoId);
                await client.query(
                    `INSERT INTO repo_file_state
                        (user_id, repo_full_name, file_path, blob_sha, size_bytes, github_repo_id)
                     VALUES ${placeholders}`,
                    values,
                );
            }
        });
    }

    async deleteFileState(userId: string, repoFullName: string): Promise<void> {
        await withUserRls(this.pool, userId, async (client) => {
            await client.query(
                `DELETE FROM repo_file_state WHERE user_id = $1 AND repo_full_name = $2`,
                [userId, repoFullName],
            );
        });
    }
}
