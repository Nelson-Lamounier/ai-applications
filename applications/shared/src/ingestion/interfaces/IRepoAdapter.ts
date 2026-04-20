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
}
