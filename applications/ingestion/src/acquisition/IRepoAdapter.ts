/**
 * @format
 * IRepoAdapter — Repository Access Contract
 *
 * Abstracts file retrieval from a version control host.
 * GitHubAdapter implements this today. GitLabAdapter or a local filesystem
 * adapter can implement it without changing the orchestrator.
 */

export type {
    RepoCommit, RepoPullRequest, RepoContributor, RepoFile,
    CommitDetail, CommitFileChange, ListCommitsOptions, ListPullRequestsOptions,
} from '@bedrock/shared';
import type {
    RepoFile, RepoCommit, RepoPullRequest, RepoContributor,
    CommitDetail, ListCommitsOptions, ListPullRequestsOptions,
} from '@bedrock/shared';

export interface ListContributorsOptions {
    /** Hard cap on contributors returned. Default 100. */
    readonly maxContributors?: number;
}

export interface GetCommitDetailOptions {
    /** Drop any single file's patch larger than this. Default 64 KiB. */
    readonly maxPatchBytes?:      number;
    /** Stop storing patches once a commit's kept patches exceed this. Default 512 KiB. */
    readonly maxTotalPatchBytes?: number;
}

/**
 * Repo-level metadata for profile extraction (language, description, topics,
 * stars/forks, fork/created/pushed dates). Lives here — not in GitHubAdapter.ts
 * — so `IRepoAdapter.getRepoMeta` can reference it without a circular import;
 * GitHubAdapter.ts re-exports it under the same name for its existing
 * consumers.
 */
export interface GitHubRepoMeta {
    primary_language: string | null;
    description:      string | null;
    topics:           string[];
    stars:            number;
    forks:            number;
    is_fork:          boolean;
    created_at:       string | null;
    pushed_at:        string | null;
}

export interface IRepoAdapter {
    /**
     * List all files in a repository at the default branch.
     * Returns metadata only — content is fetched separately.
     */
    listFiles(repoFullName: string): Promise<RepoFile[]>;

    /** HEAD commit SHA of the default branch — the cheap "anything changed" gate. */
    getHeadCommitSha(repoFullName: string): Promise<string>;

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

    /**
     * List pull requests on the repository. Implementations may return an
     * empty array if the source has no concept of pull requests.
     */
    listPullRequests?(repoFullName: string, opts?: ListPullRequestsOptions): Promise<RepoPullRequest[]>;

    /**
     * List contributors (login + contribution count), highest first. Optional —
     * adapters without a concept of contributors omit it. Used for deterministic
     * role inference + a collaboration/team-size signal.
     */
    listContributors?(repoFullName: string, opts?: ListContributorsOptions): Promise<RepoContributor[]>;

    /**
     * Fetch per-commit detail (stats + per-file diffs) from the source's
     * detail endpoint. Optional — adapters without a concept of diffs omit it.
     * Patches are size-capped per {@link GetCommitDetailOptions}.
     */
    getCommitDetail?(repoFullName: string, sha: string, opts?: GetCommitDetailOptions): Promise<CommitDetail>;

    /**
     * Fetch repo-level metadata (language, description, topics, stars/forks,
     * fork/created/pushed dates) for profile extraction. Optional — adapters
     * without a concept of repo metadata omit it. `ProfileInputCollector`
     * requires it and throws a clear error at `collect()` start when absent.
     */
    getRepoMeta?(repoFullName: string): Promise<GitHubRepoMeta>;
}
