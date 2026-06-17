/** @format */
import type { Pool } from 'pg';
import type { RepoCommit, RepoPullRequest, CommitDetail } from '../../ingestion/interfaces/IRepoAdapter.js';

/** One stored per-file change, joined with its commit — the "diffs touching file X" row. */
export interface FileChange {
    readonly commitSha:      string;
    readonly status:         string;
    readonly additions:      number;
    readonly deletions:      number;
    readonly changes:        number;
    readonly patch:          string | null;
    readonly patchTruncated: boolean;
    readonly authoredAt:     string;
    readonly message:        string;
}

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
    /**
     * @param pool         shared pg Pool
     * @param githubRepoId immutable GitHub numeric repo id, dual-written onto
     *   every repo_commits / repo_pull_requests upsert so a rename heals via a
     *   metadata update (reconcileRepoName) rather than a re-ingest. Null on
     *   legacy/pre-backfill runs — the column is nullable. The ON CONFLICT clause
     *   COALESCEs so a NULL run never clobbers a known id.
     */
    constructor(
        private readonly pool: Pool,
        private readonly githubRepoId: number | null = null,
    ) {}

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
                const base = i * 9;
                return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::timestamptz, $${base + 8}, $${base + 9})`;
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
                    this.githubRepoId,
                );
            }

            await client.query(
                `INSERT INTO repo_commits
                    (user_id, repository_id, repo_full_name, sha, author_name, author_login, authored_at, message, github_repo_id)
                 VALUES ${valuePlaceholders}
                 ON CONFLICT (repository_id, sha) DO UPDATE
                     SET author_name    = EXCLUDED.author_name,
                         author_login   = EXCLUDED.author_login,
                         authored_at    = EXCLUDED.authored_at,
                         message        = EXCLUDED.message,
                         github_repo_id = COALESCE(EXCLUDED.github_repo_id, repo_commits.github_repo_id)`,
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
                const base = i * 12;
                return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}::int, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}::timestamptz, $${base + 10}::timestamptz, $${base + 11}, $${base + 12})`;
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
                    this.githubRepoId,
                );
            }

            await client.query(
                `INSERT INTO repo_pull_requests
                    (user_id, repository_id, repo_full_name, number, title, body, state, author_login, created_at_gh, merged_at, html_url, github_repo_id)
                 VALUES ${valuePlaceholders}
                 ON CONFLICT (repository_id, number) DO UPDATE
                     SET title          = EXCLUDED.title,
                         body           = EXCLUDED.body,
                         state          = EXCLUDED.state,
                         author_login   = EXCLUDED.author_login,
                         created_at_gh  = EXCLUDED.created_at_gh,
                         merged_at      = EXCLUDED.merged_at,
                         html_url       = EXCLUDED.html_url,
                         github_repo_id = COALESCE(EXCLUDED.github_repo_id, repo_pull_requests.github_repo_id)`,
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

    /**
     * Read the change history for one file path — every stored per-file diff
     * touching it, joined with its commit, newest first. The "old vs new"
     * retrieval primitive: feed these patches + the current chunk to narration.
     */
    async getFileChanges(
        userId:       string,
        repoFullName: string,
        filePath:     string,
        limit         = 50,
    ): Promise<FileChange[]> {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);

            const result = await client.query<{
                commit_sha: string; status: string; additions: number; deletions: number;
                changes: number; patch: string | null; patch_truncated: boolean;
                authored_at: string; message: string;
            }>(
                `SELECT f.commit_sha, f.status, f.additions, f.deletions, f.changes,
                        f.patch, f.patch_truncated, c.authored_at, c.message
                   FROM repo_commit_files f
                   JOIN repo_commits c
                     ON c.repository_id = f.repository_id AND c.sha = f.commit_sha
                  WHERE f.user_id = $1::uuid
                    AND f.repo_full_name = $2
                    AND f.file_path = $3
                  ORDER BY c.authored_at DESC
                  LIMIT $4`,
                [userId, repoFullName, filePath, limit],
            );

            await client.query('COMMIT');
            return result.rows.map((r) => ({
                commitSha:      r.commit_sha,
                status:         r.status,
                additions:      r.additions,
                deletions:      r.deletions,
                changes:        r.changes,
                patch:          r.patch,
                patchTruncated: r.patch_truncated,
                authoredAt:     r.authored_at,
                message:        r.message,
            }));
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Of `shas`, return those whose commit row has no per-commit stats yet
     * (`stats_fetched_at IS NULL`) — i.e. the commits still needing a detail
     * fetch. Lets the orchestrator skip already-detailed commits so a resync
     * never re-pulls diffs it already has.
     */
    async selectShasMissingStats(
        userId:       string,
        repoFullName: string,
        shas:         string[],
    ): Promise<string[]> {
        if (shas.length === 0) return [];

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);

            const result = await client.query<{ sha: string }>(
                `SELECT sha FROM repo_commits
                  WHERE user_id = $1::uuid
                    AND repo_full_name = $2
                    AND sha = ANY($3::text[])
                    AND stats_fetched_at IS NULL`,
                [userId, repoFullName, shas],
            );

            await client.query('COMMIT');
            return result.rows.map((r) => r.sha);
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Persist per-commit detail: stamp aggregate stats onto repo_commits and
     * upsert per-file changes into repo_commit_files. One transaction; idempotent
     * via UNIQUE (repository_id, commit_sha, file_path). Returns the number of
     * file rows written.
     */
    async upsertCommitDetails(
        userId:       string,
        repositoryId: string,
        repoFullName: string,
        details:      readonly CommitDetail[],
    ): Promise<number> {
        if (details.length === 0) return 0;

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);

            let fileCount = 0;
            for (const d of details) {
                await client.query(
                    `UPDATE repo_commits
                        SET additions = $4, deletions = $5, files_changed = $6, stats_fetched_at = now()
                      WHERE repository_id = $2::uuid AND sha = $3 AND user_id = $1::uuid`,
                    [userId, repositoryId, d.sha, d.additions, d.deletions, d.filesChanged],
                );

                for (const f of d.files) {
                    await client.query(
                        `INSERT INTO repo_commit_files
                            (user_id, repository_id, repo_full_name, github_repo_id, commit_sha, file_path,
                             status, previous_filename, additions, deletions, changes, patch, patch_truncated)
                         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                         ON CONFLICT (repository_id, commit_sha, file_path) DO UPDATE
                             SET status            = EXCLUDED.status,
                                 previous_filename = EXCLUDED.previous_filename,
                                 additions         = EXCLUDED.additions,
                                 deletions         = EXCLUDED.deletions,
                                 changes           = EXCLUDED.changes,
                                 patch             = EXCLUDED.patch,
                                 patch_truncated   = EXCLUDED.patch_truncated,
                                 github_repo_id    = COALESCE(EXCLUDED.github_repo_id, repo_commit_files.github_repo_id)`,
                        [
                            userId, repositoryId, repoFullName, this.githubRepoId, d.sha, f.filePath,
                            f.status, f.previousFilename ?? null, f.additions, f.deletions, f.changes,
                            f.patch, f.patchTruncated,
                        ],
                    );
                    fileCount++;
                }
            }

            await client.query('COMMIT');
            return fileCount;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
}
