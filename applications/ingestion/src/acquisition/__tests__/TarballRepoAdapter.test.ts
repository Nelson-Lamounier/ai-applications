/**
 * @format
 * TarballRepoAdapter — tarball-backed IRepoAdapter
 *
 * Fixture is a real temp directory (fs.mkdtempSync), exercising the actual
 * filesystem walk + hashing — no network, no mocked fs.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TarballRepoAdapter, gitBlobSha } from '../TarballRepoAdapter.js';
import type {
    IRepoAdapter,
    ListCommitsOptions,
    ListPullRequestsOptions,
} from '../IRepoAdapter.js';
import type { RepoCommit, RepoPullRequest, RepoContributor, CommitDetail } from '@bedrock/shared';
import { RepoNotFoundError } from '@bedrock/shared';

// Known git blob SHA vectors (verified against `git hash-object`).
const EMPTY_FILE_SHA = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const HELLO_FILE_SHA = 'ce013625030ba8dba906f756967f9e9ca394464a';

const MULTIBYTE_CONTENT = 'héllo wörld 日本語\n'; // "héllo wörld 日本語\n"

/** Minimal stub delegate — required methods are jest.fn, optional ones added per-test. */
function stubDelegate(overrides: Partial<IRepoAdapter> = {}): IRepoAdapter {
    return {
        listFiles: jest.fn<IRepoAdapter['listFiles']>().mockResolvedValue([]),
        getHeadCommitSha: jest.fn<IRepoAdapter['getHeadCommitSha']>().mockResolvedValue('unused'),
        fetchFile: jest.fn<IRepoAdapter['fetchFile']>().mockResolvedValue('unused'),
        listCommits: jest.fn<IRepoAdapter['listCommits']>().mockResolvedValue([]),
        ...overrides,
    };
}

describe('TarballRepoAdapter', () => {
    let extractDir: string;

    beforeEach(async () => {
        extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tarball-repo-adapter-'));
        await fs.writeFile(path.join(extractDir, 'hello.txt'), 'hello\n');
        await fs.writeFile(path.join(extractDir, 'empty.txt'), '');
        await fs.mkdir(path.join(extractDir, 'nested', 'dir'), { recursive: true });
        await fs.writeFile(
            path.join(extractDir, 'nested', 'dir', 'multibyte.txt'),
            MULTIBYTE_CONTENT,
            'utf-8',
        );
    });

    afterEach(async () => {
        await fs.rm(extractDir, { recursive: true, force: true });
    });

    describe('gitBlobSha', () => {
        it('matches the known git blob SHA for an empty file', () => {
            expect(gitBlobSha(Buffer.from(''))).toBe(EMPTY_FILE_SHA);
        });

        it('matches the known git blob SHA for "hello\\n"', () => {
            expect(gitBlobSha(Buffer.from('hello\n'))).toBe(HELLO_FILE_SHA);
        });
    });

    describe('listFiles', () => {
        it('returns pinned blob SHAs for the empty and hello fixtures', async () => {
            const adapter = new TarballRepoAdapter(extractDir, 'deadbeef', stubDelegate());
            const files = await adapter.listFiles('o/r');

            const hello = files.find(f => f.path === 'hello.txt');
            const empty = files.find(f => f.path === 'empty.txt');

            expect(hello).toMatchObject({ path: 'hello.txt', sizeBytes: 6, blobSha: HELLO_FILE_SHA });
            expect(empty).toMatchObject({ path: 'empty.txt', sizeBytes: 0, blobSha: EMPTY_FILE_SHA });
        });

        it('walks nested directories and returns repo-relative POSIX paths', async () => {
            const adapter = new TarballRepoAdapter(extractDir, 'deadbeef', stubDelegate());
            const files = await adapter.listFiles('o/r');

            const nested = files.find(f => f.path === 'nested/dir/multibyte.txt');
            expect(nested).toBeDefined();
            expect(nested?.path).not.toContain('\\');
        });

        it('uses byte length (not JS string length) for sizeBytes and hashing on multi-byte content', async () => {
            const adapter = new TarballRepoAdapter(extractDir, 'deadbeef', stubDelegate());
            const files = await adapter.listFiles('o/r');
            const nested = files.find(f => f.path === 'nested/dir/multibyte.txt');

            const byteLength = Buffer.byteLength(MULTIBYTE_CONTENT, 'utf-8');
            expect(MULTIBYTE_CONTENT.length).not.toBe(byteLength); // sanity: multi-byte chars present
            expect(nested?.sizeBytes).toBe(byteLength);
            expect(nested?.blobSha).toBe(gitBlobSha(Buffer.from(MULTIBYTE_CONTENT, 'utf-8')));
        });

        it('skips symlinks defensively', async () => {
            const linkPath = path.join(extractDir, 'link-to-hello.txt');
            fsSync.symlinkSync(path.join(extractDir, 'hello.txt'), linkPath);

            const adapter = new TarballRepoAdapter(extractDir, 'deadbeef', stubDelegate());
            const files = await adapter.listFiles('o/r');

            expect(files.find(f => f.path === 'link-to-hello.txt')).toBeUndefined();
        });

        it('does not consult the delegate', async () => {
            const delegate = stubDelegate();
            const adapter = new TarballRepoAdapter(extractDir, 'deadbeef', delegate);

            await adapter.listFiles('o/r');

            expect(delegate.listFiles).not.toHaveBeenCalled();
        });
    });

    describe('getHeadCommitSha', () => {
        it('returns the resolved head SHA without consulting the delegate', async () => {
            const delegate = stubDelegate();
            const adapter = new TarballRepoAdapter(extractDir, 'resolved-sha-123', delegate);

            const sha = await adapter.getHeadCommitSha('o/r');

            expect(sha).toBe('resolved-sha-123');
            expect(delegate.getHeadCommitSha).not.toHaveBeenCalled();
        });
    });

    describe('fetchFile', () => {
        it('reads UTF-8 content from the extract root, including multi-byte content', async () => {
            const adapter = new TarballRepoAdapter(extractDir, 'deadbeef', stubDelegate());

            expect(await adapter.fetchFile('o/r', 'hello.txt')).toBe('hello\n');
            expect(await adapter.fetchFile('o/r', 'nested/dir/multibyte.txt')).toBe(MULTIBYTE_CONTENT);
        });

        it('throws RepoNotFoundError for a missing file (matches the GitHub 404 classification)', async () => {
            const adapter = new TarballRepoAdapter(extractDir, 'deadbeef', stubDelegate());

            await expect(adapter.fetchFile('o/r', 'does-not-exist.txt')).rejects.toThrow(RepoNotFoundError);
            await expect(adapter.fetchFile('o/r', 'does-not-exist.txt')).rejects.toThrow(/does-not-exist\.txt/);
        });

        it('rejects a relative path that escapes the extract root', async () => {
            const adapter = new TarballRepoAdapter(extractDir, 'deadbeef', stubDelegate());

            await expect(adapter.fetchFile('o/r', '../outside.txt')).rejects.toThrow(/escapes/i);
        });

        it('rejects an absolute path outside the extract root', async () => {
            const adapter = new TarballRepoAdapter(extractDir, 'deadbeef', stubDelegate());

            await expect(adapter.fetchFile('o/r', '/etc/passwd')).rejects.toThrow(/escapes/i);
        });

        it('does not consult the delegate', async () => {
            const delegate = stubDelegate();
            const adapter = new TarballRepoAdapter(extractDir, 'deadbeef', delegate);

            await adapter.fetchFile('o/r', 'hello.txt');

            expect(delegate.fetchFile).not.toHaveBeenCalled();
        });
    });

    describe('listCommits delegation', () => {
        it('forwards args and results to the delegate', async () => {
            const commits: RepoCommit[] = [
                { sha: 'abc', authorName: 'A', authoredAt: '2026-01-01T00:00:00Z', message: 'msg' },
            ];
            const delegate = stubDelegate({
                listCommits: jest.fn<IRepoAdapter['listCommits']>().mockResolvedValue(commits),
            });
            const adapter = new TarballRepoAdapter(extractDir, 'deadbeef', delegate);
            const opts: ListCommitsOptions = { maxCommits: 10 };

            const result = await adapter.listCommits('o/r', opts);

            expect(result).toBe(commits);
            expect(delegate.listCommits).toHaveBeenCalledWith('o/r', opts);
        });
    });

    describe('optional method delegation matches delegate optionality', () => {
        it('exposes listPullRequests/listContributors/getCommitDetail when the delegate defines them', async () => {
            const pulls: RepoPullRequest[] = [];
            const contributors: RepoContributor[] = [];
            const detail: CommitDetail = { sha: 'abc', additions: 0, deletions: 0, filesChanged: 0, files: [] };

            const delegate = stubDelegate({
                listPullRequests: jest.fn<Required<IRepoAdapter>['listPullRequests']>().mockResolvedValue(pulls),
                listContributors: jest.fn<Required<IRepoAdapter>['listContributors']>().mockResolvedValue(contributors),
                getCommitDetail: jest.fn<Required<IRepoAdapter>['getCommitDetail']>().mockResolvedValue(detail),
            });
            const adapter = new TarballRepoAdapter(extractDir, 'deadbeef', delegate);

            expect(typeof adapter.listPullRequests).toBe('function');
            expect(typeof adapter.listContributors).toBe('function');
            expect(typeof adapter.getCommitDetail).toBe('function');

            const prOpts: ListPullRequestsOptions = { state: 'all' };
            expect(await adapter.listPullRequests!('o/r', prOpts)).toBe(pulls);
            expect(delegate.listPullRequests).toHaveBeenCalledWith('o/r', prOpts);

            expect(await adapter.listContributors!('o/r')).toBe(contributors);
            expect(await adapter.getCommitDetail!('o/r', 'abc')).toBe(detail);
        });

        it('mirrors the orchestrator guard (typeof !== "function") when the delegate omits them', async () => {
            const delegate = stubDelegate(); // no optional methods defined
            const adapter = new TarballRepoAdapter(extractDir, 'deadbeef', delegate);

            expect(typeof adapter.listPullRequests).not.toBe('function');
            expect(typeof adapter.listContributors).not.toBe('function');
            expect(typeof adapter.getCommitDetail).not.toBe('function');
        });
    });
});
