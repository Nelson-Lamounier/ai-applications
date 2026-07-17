/**
 * @format
 * TarballRepoAdapter — tarball-backed IRepoAdapter
 *
 * Wraps an already-downloaded-and-extracted repo tree (see fetchTarball.ts +
 * safeExtract.ts) so the unified ingestion path can list/read files from
 * local disk instead of one HTTP call per file. This makes the tarball
 * download the ONE network round trip for file content, while tier-2
 * incremental sync (RepoIngestionOrchestrator's blob-SHA diff) keeps working
 * unchanged because `listFiles` reproduces the exact git blob SHA GitHub's
 * Trees API would have returned.
 *
 * `listFiles` / `getHeadCommitSha` / `fetchFile` operate purely on
 * `extractDir` — no network. Everything else IRepoAdapter can expose
 * (commits, pull requests, contributors, commit detail) has no tarball-local
 * representation, so those calls are forwarded to `delegate` — the same
 * host adapter (e.g. GitHubAdapter) that still has API access.
 *
 * Optional-method optionality: IRepoAdapter declares listPullRequests /
 * listContributors / getCommitDetail as optional (`method?`), and
 * RepoIngestionOrchestrator feature-detects them with
 * `typeof adapter.xxx !== 'function'`. A plain class method is always
 * defined on the prototype — even one that only forwards — which would make
 * a delegate WITHOUT that capability look like it has it. So these three
 * are declared `declare` (type-only, no prototype method) and assigned as
 * instance properties in the constructor ONLY when `delegate` itself
 * defines them, keeping `typeof adapter.xxx` identical to
 * `typeof delegate.xxx` for every optional method.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
    IRepoAdapter,
    ListCommitsOptions,
    RepoCommit,
    RepoFile,
} from './IRepoAdapter.js';

/**
 * Git blob SHA-1: `sha1("blob " + byteLength + "\0" + content)`. Matches
 * `git hash-object` and the SHA GitHub's Trees API returns for the same
 * bytes — the per-file change key RepoIngestionOrchestrator's tier-2 diff
 * relies on. `content` must be the raw bytes (not a decoded string) so
 * multi-byte UTF-8 content hashes on byte length, not JS string length.
 */
export function gitBlobSha(content: Buffer): string {
    return createHash('sha1')
        .update(`blob ${content.length}\0`)
        .update(content)
        .digest('hex');
}

export class TarballRepoAdapter implements IRepoAdapter {
    declare listPullRequests?: IRepoAdapter['listPullRequests'];
    declare listContributors?: IRepoAdapter['listContributors'];
    declare getCommitDetail?: IRepoAdapter['getCommitDetail'];

    private readonly rootDir: string;

    constructor(
        private readonly extractDir: string,
        private readonly resolvedHeadSha: string,
        private readonly delegate: IRepoAdapter,
    ) {
        this.rootDir = path.resolve(extractDir);

        if (delegate.listPullRequests) {
            const listPullRequests = delegate.listPullRequests.bind(delegate);
            this.listPullRequests = (repoFullName, opts) => listPullRequests(repoFullName, opts);
        }
        if (delegate.listContributors) {
            const listContributors = delegate.listContributors.bind(delegate);
            this.listContributors = (repoFullName, opts) => listContributors(repoFullName, opts);
        }
        if (delegate.getCommitDetail) {
            const getCommitDetail = delegate.getCommitDetail.bind(delegate);
            this.getCommitDetail = (repoFullName, sha, opts) => getCommitDetail(repoFullName, sha, opts);
        }
    }

    // =========================================================================
    // IRepoAdapter.listFiles — recursive local walk, no network
    // =========================================================================

    async listFiles(_repoFullName: string): Promise<RepoFile[]> {
        return this.walk(this.rootDir);
    }

    private async walk(dir: string): Promise<RepoFile[]> {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        const out: RepoFile[] = [];

        for (const entry of entries) {
            const abs = path.join(dir, entry.name);

            // Defensive — safeExtract already rejects symlinks/hardlinks at
            // extraction time, but a hand-built or pre-existing tree might not.
            if (entry.isSymbolicLink()) continue;

            if (entry.isDirectory()) {
                out.push(...await this.walk(abs));
                continue;
            }
            if (!entry.isFile()) continue; // skip devices/sockets/fifos etc.

            const [stat, content] = await Promise.all([fs.stat(abs), fs.readFile(abs)]);
            out.push({
                path:      this.toRepoRelativePosixPath(abs),
                sizeBytes: stat.size,
                blobSha:   gitBlobSha(content),
            });
        }

        return out;
    }

    /** Repo-relative path with forward slashes, matching what GitHubAdapter's tree listing returns. */
    private toRepoRelativePosixPath(absPath: string): string {
        return path.relative(this.rootDir, absPath).split(path.sep).join('/');
    }

    // =========================================================================
    // IRepoAdapter.getHeadCommitSha — no network; resolved once at fetchTarball time
    // =========================================================================

    async getHeadCommitSha(_repoFullName: string): Promise<string> {
        return this.resolvedHeadSha;
    }

    // =========================================================================
    // IRepoAdapter.fetchFile — read from the extracted tree, no network
    // =========================================================================

    async fetchFile(_repoFullName: string, filePath: string): Promise<string> {
        const abs = path.resolve(this.rootDir, filePath);
        if (abs !== this.rootDir && !abs.startsWith(this.rootDir + path.sep)) {
            throw new Error(`TarballRepoAdapter.fetchFile: path escapes extract root: ${filePath}`);
        }

        try {
            return await fs.readFile(abs, 'utf-8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new Error(`TarballRepoAdapter.fetchFile: file not found: ${filePath}`);
            }
            throw err;
        }
    }

    // =========================================================================
    // IRepoAdapter.listCommits — required by the interface; delegated (no
    // tarball-local representation of commit history)
    // =========================================================================

    async listCommits(repoFullName: string, opts?: ListCommitsOptions): Promise<RepoCommit[]> {
        return this.delegate.listCommits(repoFullName, opts);
    }
}
