/** @format */
import type { Pool } from 'pg';
import { withUserRls } from '../with-user-rls.js';
import type { RepoCommit, RepoPullRequest, RepoContributor, CommitDetail } from '../../repo-entities.js';

/** A measured performance metric recorded at a commit SHA (never LLM-produced). */
export interface PerfMetric {
    readonly commitSha:  string;
    readonly metricName: string;
    readonly value:      number;
    readonly unit:       string;
    readonly source:     string;
    readonly measuredAt: string;
}

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
 * Both are RLS-protected on `app.current_user_id`, so every call runs through
 * `withUserRls`, which demotes to `tucaken_app` and stamps that GUC in the
 * same transaction.
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

        return withUserRls(this.pool, userId, async (client) => {
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

            return commits.length;
        });
    }

    async upsertPullRequests(
        userId:       string,
        repositoryId: string,
        repoFullName: string,
        pulls:        readonly RepoPullRequest[],
    ): Promise<number> {
        if (pulls.length === 0) return 0;

        return withUserRls(this.pool, userId, async (client) => {
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

            return pulls.length;
        });
    }

    async upsertContributors(
        userId:       string,
        repositoryId: string,
        repoFullName: string,
        contributors: readonly RepoContributor[],
    ): Promise<number> {
        const rows = contributors.filter((c): c is RepoContributor & { login: string } => !!c.login);
        if (rows.length === 0) return 0;

        return withUserRls(this.pool, userId, async (client) => {
            const valuePlaceholders = rows.map((_, i) => {
                const base = i * 6;
                return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}, $${base + 5}::int, $${base + 6})`;
            }).join(', ');

            const values: unknown[] = [];
            for (const c of rows) {
                values.push(userId, repositoryId, repoFullName, c.login, c.contributions, this.githubRepoId);
            }

            await client.query(
                `INSERT INTO repo_contributors
                    (user_id, repository_id, repo_full_name, login, contributions, github_repo_id)
                 VALUES ${valuePlaceholders}
                 ON CONFLICT (repository_id, login) DO UPDATE
                     SET contributions  = EXCLUDED.contributions,
                         repo_full_name = EXCLUDED.repo_full_name,
                         github_repo_id = COALESCE(EXCLUDED.github_repo_id, repo_contributors.github_repo_id),
                         fetched_at     = now()`,
                values,
            );

            return rows.length;
        });
    }

    /**
     * Persist measured performance metrics for commits. Idempotent via
     * UNIQUE (repository_id, commit_sha, metric_name). Source is the measurement
     * provenance (e.g. 'ci-benchmark') — never an LLM. Returns rows written.
     */
    async upsertCommitPerf(
        userId:       string,
        repositoryId: string,
        repoFullName: string,
        metrics:      readonly PerfMetric[],
    ): Promise<number> {
        if (metrics.length === 0) return 0;

        return withUserRls(this.pool, userId, async (client) => {
            for (const m of metrics) {
                await client.query(
                    `INSERT INTO repo_commit_perf
                        (user_id, repository_id, repo_full_name, github_repo_id, commit_sha,
                         metric_name, value, unit, source, measured_at)
                     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
                     ON CONFLICT (repository_id, commit_sha, metric_name) DO UPDATE
                         SET value          = EXCLUDED.value,
                             unit           = EXCLUDED.unit,
                             source         = EXCLUDED.source,
                             measured_at    = EXCLUDED.measured_at,
                             github_repo_id = COALESCE(EXCLUDED.github_repo_id, repo_commit_perf.github_repo_id)`,
                    [userId, repositoryId, repoFullName, this.githubRepoId, m.commitSha,
                     m.metricName, m.value, m.unit, m.source, m.measuredAt],
                );
            }

            return metrics.length;
        });
    }

    /** Read measured performance metrics recorded at a commit SHA. */
    async getMeasuredPerf(
        userId:       string,
        repoFullName: string,
        sha:          string,
    ): Promise<PerfMetric[]> {
        return withUserRls(this.pool, userId, async (client) => {
            const result = await client.query<{
                commit_sha: string; metric_name: string; value: number | string;
                unit: string; source: string; measured_at: string;
            }>(
                `SELECT commit_sha, metric_name, value, unit, source, measured_at
                   FROM repo_commit_perf
                  WHERE user_id = $1::uuid AND repo_full_name = $2 AND commit_sha = $3
                  ORDER BY metric_name`,
                [userId, repoFullName, sha],
            );

            return result.rows.map((r) => ({
                commitSha:  r.commit_sha,
                metricName: r.metric_name,
                value:      Number(r.value),
                unit:       r.unit,
                source:     r.source,
                measuredAt: r.measured_at,
            }));
        });
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
        return withUserRls(this.pool, userId, async (client) => {
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
        });
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

        return withUserRls(this.pool, userId, async (client) => {
            const result = await client.query<{ sha: string }>(
                `SELECT sha FROM repo_commits
                  WHERE user_id = $1::uuid
                    AND repo_full_name = $2
                    AND sha = ANY($3::text[])
                    AND stats_fetched_at IS NULL`,
                [userId, repoFullName, shas],
            );

            return result.rows.map((r) => r.sha);
        });
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

        return withUserRls(this.pool, userId, async (client) => {
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

            return fileCount;
        });
    }
}
