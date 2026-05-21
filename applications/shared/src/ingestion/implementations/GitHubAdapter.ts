/**
 * @format
 * GitHubAdapter — IRepoAdapter backed by the GitHub REST API
 *
 * Uses the Git Trees API (recursive=1) to list all files in one request,
 * then fetches individual file content via the Blobs API.
 *
 * Authentication:
 *   Requires a GitHub Personal Access Token (PAT) with `contents:read` scope.
 *   Token is resolved from the GITHUB_TOKEN environment variable.
 *   For private repos, a Fine-Grained PAT scoped to the specific repository
 *   is recommended over a classic PAT.
 *
 * Rate limiting:
 *   Authenticated requests: 5000 req/hour.
 *   The recursive tree listing counts as 1 request regardless of repo size.
 *   Each fetchFile() call counts as 1 request.
 *   For repos with > 100 files to index, batch fetches behind a semaphore
 *   (3–5 concurrent) to stay within rate limits. This adapter is sequential
 *   by default — the orchestrator controls concurrency.
 *
 * Future:
 *   GitLabAdapter implements the same IRepoAdapter contract using
 *   GitLab's Repository Files API. The orchestrator is unaffected.
 */

import https from 'https';

import type {
    IRepoAdapter,
    ListCommitsOptions,
    ListPullRequestsOptions,
    RepoCommit,
    RepoFile,
    RepoPullRequest,
} from '../interfaces/IRepoAdapter.js';

// =============================================================================
// INTERNAL TYPES — GitHub API response shapes
// =============================================================================

interface GitHubTreeItem {
    path: string;
    type: 'blob' | 'tree';
    size?: number;
    sha:  string;
    url:  string;
}

interface GitHubTreeResponse {
    sha:       string;
    tree:      GitHubTreeItem[];
    /**
     * true when the repo has > ~100K tree entries and GitHub omitted the rest.
     * In this case the flat recursive call is incomplete — we must fall back to
     * manual directory-by-directory traversal using non-recursive tree requests.
     */
    truncated: boolean;
}

interface GitHubBlobResponse {
    content:  string;   // base64-encoded
    encoding: 'base64' | 'utf-8';
}

/**
 * Subset of GitHub's commit-list-item shape we consume.
 * `author` is the GitHub user (may be null for unattributed/email-only commits);
 * `commit.author` is the git author block from the commit object itself.
 */
interface GitHubCommitListItem {
    sha:    string;
    author: { login: string } | null;
    commit: {
        message:   string;
        author?:   { name?: string; email?: string; date?: string };
        committer?:{ name?: string; email?: string; date?: string };
    };
}

/** Subset of GitHub's pull-request-list-item shape we consume. */
interface GitHubPullRequestListItem {
    number:       number;
    title:        string;
    body:         string | null;
    state:        'open' | 'closed';
    user:         { login: string } | null;
    created_at:   string;
    merged_at:    string | null;
    html_url:     string;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Well-known directories to skip during manual tree traversal.
 * These are never useful for knowledge-base ingestion and would cause
 * thousands of unnecessary API calls if committed accidentally.
 */
const SKIP_DIRS = new Set([
    'node_modules',
    '.yarn',
    'vendor',
    'dist',
    'build',
    'out',
    '.next',
    'cdk.out',
    'coverage',
    '.git',
]);

// =============================================================================
// PUBLIC TYPES — GitHubAdapter-specific (not part of IRepoAdapter)
// =============================================================================

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

export class GitHubAdapter implements IRepoAdapter {
    private readonly token: string;
    private readonly apiBase = 'api.github.com';

    constructor(token: string) {
        this.token = token;
    }

    static fromEnvironment(): GitHubAdapter {
        const token = process.env.GITHUB_TOKEN;
        if (!token) {
            throw new Error(
                'GitHubAdapter: GITHUB_TOKEN environment variable is required',
            );
        }
        return new GitHubAdapter(token);
    }

    // =========================================================================
    // IRepoAdapter.listFiles
    // =========================================================================

    async listFiles(repoFullName: string): Promise<RepoFile[]> {
        // Step 1: resolve the default branch HEAD SHA
        const repoInfo = await this.get<{ default_branch: string }>(
            `/repos/${repoFullName}`,
        );

        // Step 2: attempt single-call recursive tree listing
        const tree = await this.get<GitHubTreeResponse>(
            `/repos/${repoFullName}/git/trees/${repoInfo.default_branch}?recursive=1`,
        );

        if (!tree.truncated) {
            return tree.tree
                .filter(item => item.type === 'blob')
                .map(item => ({
                    path:      item.path,
                    sizeBytes: item.size ?? 0,
                }));
        }

        // Step 3: tree was truncated (repo has > ~100K entries) —
        // fall back to manual directory-by-directory traversal.
        //
        // We re-use the root tree already returned (it contains the top-level
        // entries even when truncated) and recursively fetch sub-trees for
        // each directory node. This is more API calls (one per directory) but
        // guarantees completeness for repos of any size.
        //
        // FileFilter will exclude node_modules and build output *after* listing,
        // but we short-circuit the most expensive case here to avoid O(10K) API
        // calls on repos that committed their dependencies.
        console.warn(
            `[GitHubAdapter] recursive tree truncated for ${repoFullName} ` +
            `(> ~100K entries). Falling back to per-directory traversal. ` +
            `This will use more API requests — ensure GITHUB_TOKEN has sufficient rate-limit headroom.`,
        );

        return this.traverseTree(repoFullName, tree.tree, '');
    }

    /**
     * Recursively collect all blob entries from a tree, fetching sub-trees
     * on demand. Called only when the flat recursive listing is truncated.
     *
     * @param repoFullName - "owner/repo"
     * @param items        - Tree items from the parent tree response
     * @param prefix       - Accumulated path prefix for this level
     */
    private async traverseTree(
        repoFullName: string,
        items: GitHubTreeItem[],
        prefix: string,
    ): Promise<RepoFile[]> {
        const files: RepoFile[] = [];

        for (const item of items) {
            const fullPath = prefix ? `${prefix}/${item.path}` : item.path;

            if (item.type === 'blob') {
                files.push({ path: fullPath, sizeBytes: item.size ?? 0 });

            } else if (item.type === 'tree') {
                // Short-circuit well-known large directories to avoid thousands
                // of API calls on repos that committed artifacts.
                // FileFilter excludes these after listing, but skipping here
                // avoids paying the network cost for files we will never use.
                if (SKIP_DIRS.has(item.path)) continue;

                const subTree = await this.get<GitHubTreeResponse>(
                    `/repos/${repoFullName}/git/trees/${item.sha}`,
                );

                const subFiles = await this.traverseTree(
                    repoFullName,
                    subTree.tree,
                    fullPath,
                );
                files.push(...subFiles);
            }
        }

        return files;
    }

    // =========================================================================
    // IRepoAdapter.fetchFile
    // =========================================================================

    async fetchFile(repoFullName: string, filePath: string): Promise<string> {
        // Encode each segment individually — encodeURIComponent on the full
        // path would encode '/' to '%2F' which GitHub's Contents API rejects.
        const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');

        const blob = await this.get<GitHubBlobResponse>(
            `/repos/${repoFullName}/contents/${encodedPath}`,
        );

        if (blob.encoding === 'base64') {
            return Buffer.from(blob.content.replace(/\n/g, ''), 'base64').toString('utf-8');
        }

        return blob.content;
    }

    // =========================================================================
    // IRepoAdapter.listCommits
    // =========================================================================

    /**
     * List commits on the default branch in reverse chronological order.
     *
     * Uses only the list endpoint (`/commits`) — does NOT fetch per-commit
     * detail (`/commits/{sha}`). The list endpoint omits affected file lists
     * and additions/deletions counts. A future per-file-timeline feature can
     * opt into the per-commit detail cost separately.
     *
     * Pagination: 100 commits per page (GitHub's max). Stops on first empty
     * page or when `maxCommits` is reached.
     *
     * @param repoFullName - "owner/repo"
     * @param opts.maxCommits - default 500
     * @param opts.since      - ISO 8601 timestamp; only commits at/after included
     */
    async listCommits(
        repoFullName: string,
        opts: ListCommitsOptions = {},
    ): Promise<RepoCommit[]> {
        const max   = opts.maxCommits ?? 500;
        const since = opts.since;

        // Resolve default branch to scope listing strictly to the trunk.
        const repoInfo = await this.get<{ default_branch: string }>(
            `/repos/${repoFullName}`,
        );

        const out: RepoCommit[] = [];
        const perPage = 100;

        for (let page = 1; out.length < max; page++) {
            const qs: string[] = [
                `sha=${encodeURIComponent(repoInfo.default_branch)}`,
                `per_page=${perPage}`,
                `page=${page}`,
            ];
            if (since) qs.push(`since=${encodeURIComponent(since)}`);

            const batch = await this.get<GitHubCommitListItem[]>(
                `/repos/${repoFullName}/commits?${qs.join('&')}`,
            );

            if (batch.length === 0) break;

            for (const c of batch) {
                if (out.length >= max) break;
                out.push({
                    sha:         c.sha,
                    authorLogin: c.author?.login,
                    authorName:  c.commit.author?.name ?? '(unknown)',
                    authoredAt:  c.commit.author?.date ?? c.commit.committer?.date ?? '',
                    message:     c.commit.message ?? '',
                });
            }

            // GitHub returned fewer than perPage → last page reached.
            if (batch.length < perPage) break;
        }

        return out;
    }

    // =========================================================================
    // IRepoAdapter.listPullRequests
    // =========================================================================

    /**
     * List pull requests on the repository. Paginates 100/page like
     * listCommits; stops on the first short page or when `maxPullRequests`
     * is reached.
     *
     * GitHub returns `merged_at: null` for both closed-without-merge and
     * still-open PRs; we normalise the merged-state into the `state`
     * enum: `'merged' | 'closed' | 'open'`.
     *
     * @param opts.maxPullRequests - default 100
     * @param opts.state - 'open' | 'closed' | 'all' (default 'all')
     * @param opts.since - ISO 8601; only PRs updated at/after included
     */
    async listPullRequests(
        repoFullName: string,
        opts: ListPullRequestsOptions = {},
    ): Promise<RepoPullRequest[]> {
        const max     = opts.maxPullRequests ?? 100;
        const state   = opts.state ?? 'all';
        const since   = opts.since;
        const perPage = 100;

        const out: RepoPullRequest[] = [];
        for (let page = 1; out.length < max; page++) {
            const qs: string[] = [
                `state=${state}`,
                `sort=updated`,
                `direction=desc`,
                `per_page=${perPage}`,
                `page=${page}`,
            ];

            const batch = await this.get<GitHubPullRequestListItem[]>(
                `/repos/${repoFullName}/pulls?${qs.join('&')}`,
            );

            if (batch.length === 0) break;

            for (const p of batch) {
                if (out.length >= max) break;
                if (since && p.created_at < since) continue;
                const normalisedState: RepoPullRequest['state'] =
                    p.merged_at ? 'merged' : p.state;
                out.push({
                    number:      p.number,
                    title:       p.title,
                    body:        p.body,
                    createdAt:   p.created_at,
                    mergedAt:    p.merged_at,
                    state:       normalisedState,
                    authorLogin: p.user?.login ?? null,
                    htmlUrl:     p.html_url,
                });
            }

            if (batch.length < perPage) break;
        }

        return out;
    }

    // =========================================================================
    // GitHubAdapter.getRepoMeta (not part of IRepoAdapter — profile-specific)
    // =========================================================================

    async getRepoMeta(repoFullName: string): Promise<GitHubRepoMeta> {
        const data = await this.get<{
            language:          string | null;
            description:       string | null;
            topics:            string[] | undefined;
            stargazers_count:  number;
            forks_count:       number;
            fork:              boolean;
            created_at:        string | null;
            pushed_at:         string | null;
        }>(`/repos/${repoFullName}`);

        return {
            primary_language: data.language,
            description:      data.description,
            topics:           data.topics ?? [],   // GitHub omits field when no topics set
            stars:            data.stargazers_count,
            forks:            data.forks_count,
            is_fork:          data.fork,
            created_at:       data.created_at,
            pushed_at:        data.pushed_at,
        };
    }

    // =========================================================================
    // Private — HTTPS request helper
    // =========================================================================

    private get<T>(path: string): Promise<T> {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: this.apiBase,
                path,
                method:   'GET',
                headers:  {
                    'Authorization': `Bearer ${this.token}`,
                    'User-Agent':    'portfolio-ingestion/1.0',
                    'Accept':        'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            };

            const req = https.request(options, res => {
                const chunks: Buffer[] = [];

                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf-8');

                    if (!res.statusCode || res.statusCode >= 400) {
                        reject(new Error(
                            `GitHub API ${path} returned ${res.statusCode}: ${body}`,
                        ));
                        return;
                    }

                    try {
                        resolve(JSON.parse(body) as T);
                    } catch {
                        reject(new Error(`GitHub API ${path}: invalid JSON response`));
                    }
                });
            });

            req.on('error', reject);
            req.end();
        });
    }
}
