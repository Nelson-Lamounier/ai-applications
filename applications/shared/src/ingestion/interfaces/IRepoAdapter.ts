/**
 * @format
 * IRepoAdapter — Repository Access Contract
 *
 * Abstracts file retrieval from a version control host.
 * GitHubAdapter implements this today. GitLabAdapter or a local filesystem
 * adapter can implement it without changing the orchestrator.
 */

export interface RepoFile {
    readonly path: string;
    /** File size in bytes — used for pre-filtering oversized files */
    readonly sizeBytes: number;
}

/**
 * A single commit on the default branch.
 *
 * Pulled from the list-commits endpoint only — affected file list and
 * additions/deletions counts are NOT included here because they require a
 * separate per-commit detail call (1 API request per commit, expensive at
 * scale). A future per-file timeline derivation may opt in to that cost.
 */
export interface RepoCommit {
    readonly sha:           string;
    /** Commit author's git login on the host (may differ from `authorName`). */
    readonly authorLogin?:  string;
    /** Commit author's display name from the commit metadata. */
    readonly authorName:    string;
    /** Author date in ISO 8601 (UTC). */
    readonly authoredAt:    string;
    /** Full commit message (subject + body). */
    readonly message:       string;
}

export interface ListCommitsOptions {
    /** Hard cap on commits returned. Default 500. */
    readonly maxCommits?: number;
    /**
     * Only include commits authored on or after this ISO 8601 timestamp.
     * Used for incremental ingestion (resume from `last_synced_at`).
     */
    readonly since?:      string;
}

export interface IRepoAdapter {
    /**
     * List all files in a repository at the default branch.
     * Returns metadata only — content is fetched separately.
     */
    listFiles(repoFullName: string): Promise<RepoFile[]>;

    /**
     * Fetch the UTF-8 content of a single file.
     *
     * @param repoFullName - "owner/repo"
     * @param filePath     - Relative path within the repo (from listFiles)
     */
    fetchFile(repoFullName: string, filePath: string): Promise<string>;

    /**
     * List commits on the default branch in reverse chronological order.
     * Implementations may return an empty array if the source has no
     * concept of commits (e.g. a Figma adapter).
     */
    listCommits(repoFullName: string, opts?: ListCommitsOptions): Promise<RepoCommit[]>;
}
