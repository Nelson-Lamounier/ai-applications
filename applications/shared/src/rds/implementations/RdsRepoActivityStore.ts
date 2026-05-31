/** @format */
import type { Pool } from 'pg';
import type { RepoCommit, RepoPullRequest } from '../../ingestion/interfaces/IRepoAdapter.js';

/**
 * RdsRepoActivityStore — persists structured git commits and pull requests
 * captured during ingestion.
 *
 * Tables (migration 045):
 *   - repo_commits         UNIQUE (repository_id, sha)
 *   - repo_pull_requests   UNIQUE (repository_id, number)
 * Both are RLS-protected on `app.current_user_id`, so every write runs inside a
 * transaction that first sets that GUC via set_config().
 */
export class RdsRepoActivityStore {
    constructor(private readonly pool: Pool) {}

    async upsertCommits(
        userId:       string,
        repositoryId: string,
        repoFullName: string,
        commits:      readonly RepoCommit[],
    ): Promise<number> {
        if (commits.length === 0) return 0;

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);

            const valuePlaceholders = commits.map((_, i) => {
                const base = i * 8;
                return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::timestamptz, $${base + 8})`;
            }).join(', ');

            const values: unknown[] = [];
            for (const c of commits) {
                values.push(
                    userId,
                    repositoryId,
                    repoFullName,
                    c.sha,
                    c.authorName,
                    c.authorLogin ?? null,
                    c.authoredAt,
                    c.message,
                );
            }

            await client.query(
                `INSERT INTO repo_commits
                    (user_id, repository_id, repo_full_name, sha, author_name, author_login, authored_at, message)
                 VALUES ${valuePlaceholders}
                 ON CONFLICT (repository_id, sha) DO UPDATE
                     SET author_name  = EXCLUDED.author_name,
                         author_login = EXCLUDED.author_login,
                         authored_at  = EXCLUDED.authored_at,
                         message      = EXCLUDED.message`,
                values,
            );

            await client.query('COMMIT');
            return commits.length;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async upsertPullRequests(
        userId:       string,
        repositoryId: string,
        repoFullName: string,
        pulls:        readonly RepoPullRequest[],
    ): Promise<number> {
        if (pulls.length === 0) return 0;

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);

            const valuePlaceholders = pulls.map((_, i) => {
                const base = i * 11;
                return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}::int, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}::timestamptz, $${base + 10}::timestamptz, $${base + 11})`;
            }).join(', ');

            const values: unknown[] = [];
            for (const p of pulls) {
                values.push(
                    userId,
                    repositoryId,
                    repoFullName,
                    p.number,
                    p.title,
                    p.body ?? null,
                    p.state,
                    p.authorLogin ?? null,
                    p.createdAt,
                    p.mergedAt ?? null,
                    p.htmlUrl,
                );
            }

            await client.query(
                `INSERT INTO repo_pull_requests
                    (user_id, repository_id, repo_full_name, number, title, body, state, author_login, created_at_gh, merged_at, html_url)
                 VALUES ${valuePlaceholders}
                 ON CONFLICT (repository_id, number) DO UPDATE
                     SET title         = EXCLUDED.title,
                         body          = EXCLUDED.body,
                         state         = EXCLUDED.state,
                         author_login  = EXCLUDED.author_login,
                         created_at_gh = EXCLUDED.created_at_gh,
                         merged_at     = EXCLUDED.merged_at,
                         html_url      = EXCLUDED.html_url`,
                values,
            );

            await client.query('COMMIT');
            return pulls.length;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
}
