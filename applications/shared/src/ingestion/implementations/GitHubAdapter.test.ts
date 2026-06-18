/**
 * @format
 * GitHubAdapter — blob-SHA surfacing + HEAD-commit gate
 *
 * The adapter's HTTP layer is a private `get<T>(path)` helper. We intercept it
 * with a tiny subclass that resolves a route map instead of hitting the network.
 * This keeps the tests hermetic and faithful to the adapter's real call shapes.
 */

import { describe, it, expect, jest } from '@jest/globals';

import { GitHubAdapter } from './GitHubAdapter.js';
import { GitHubResponseShapeError } from './github-errors.js';

/**
 * Build a GitHubAdapter whose private HTTPS `get` is replaced by a route map.
 * Keys are exact request paths the adapter builds; values are the parsed
 * JSON bodies the real API would return. We replace the method on the
 * instance (the only HTTP seam) rather than subclassing, since `get` is
 * private and cannot be overridden through the class hierarchy.
 */
function routedAdapter(routes: Record<string, unknown>): GitHubAdapter {
    const adapter = new GitHubAdapter('test-token');
    (adapter as unknown as { get<T>(path: string): Promise<T> }).get =
        <T,>(path: string): Promise<T> => {
            if (!(path in routes)) {
                return Promise.reject(new Error(`unmapped route: ${path}`));
            }
            return Promise.resolve(routes[path] as T);
        };
    return adapter;
}

describe('GitHubAdapter.listFiles', () => {
    it('surfaces the git blob SHA on each RepoFile', async () => {
        const adapter = routedAdapter({
            '/repos/o/r': { default_branch: 'main' },
            '/repos/o/r/git/trees/main?recursive=1': {
                sha:       'tree_root',
                truncated: false,
                tree: [
                    { path: 'a.ts', type: 'blob', size: 5, sha: 'blob_a', url: '' },
                ],
            },
        });

        const files = await adapter.listFiles('o/r');

        expect(files[0]).toMatchObject({
            path:      'a.ts',
            sizeBytes: 5,
            blobSha:   'blob_a',
        });
    });
});

describe('GitHubAdapter.getHeadCommitSha', () => {
    it('returns the HEAD commit SHA of the default branch', async () => {
        const adapter = routedAdapter({
            '/repos/o/r': { default_branch: 'main' },
            '/repos/o/r/commits/main': { sha: 'head123' },
        });

        await expect(adapter.getHeadCommitSha('o/r')).resolves.toBe('head123');
    });
});

describe('GitHubAdapter.listFiles shape guard', () => {
  it('throws GitHubResponseShapeError when the tree response has no tree array', async () => {
    // A renamed repo 301-redirects; if the body leaks through it looks like
    // { message, url } — no `tree`. Must not crash on `.tree.filter`.
    const adapter = routedAdapter({
      '/repos/o/r': { default_branch: 'main' },
      '/repos/o/r/git/trees/main?recursive=1': { message: 'Moved Permanently', url: 'https://api.github.com/repositories/42' },
    });

    await expect(adapter.listFiles('o/r')).rejects.toBeInstanceOf(GitHubResponseShapeError);
  });
});

describe('GitHubAdapter.listCommits shape guard', () => {
  it('throws GitHubResponseShapeError when the commits response is not an array', async () => {
    const adapter = routedAdapter({
      '/repos/o/r': { default_branch: 'main' },
      '/repos/o/r/commits?sha=main&per_page=100&page=1': { message: 'Moved Permanently', url: 'https://api.github.com/repositories/42' },
    });

    await expect(adapter.listCommits('o/r')).rejects.toBeInstanceOf(GitHubResponseShapeError);
  });

  it('still lists commits for a valid array response', async () => {
    const adapter = routedAdapter({
      '/repos/o/r': { default_branch: 'main' },
      '/repos/o/r/commits?sha=main&per_page=100&page=1': [
        { sha: 'c1', author: { login: 'me' }, commit: { message: 'init', author: { name: 'Me', date: '2026-01-01T00:00:00Z' } } },
      ],
    });

    const commits = await adapter.listCommits('o/r');
    expect(commits[0]).toMatchObject({ sha: 'c1', authorLogin: 'me', message: 'init' });
  });

  it('warns when history is truncated by the maxCommits cap', async () => {
    // A full page (100) of commits available, but the caller caps at 2 → the
    // cap is hit mid-page, so older history is dropped and must be flagged.
    const fullPage = Array.from({ length: 100 }, (_v, i) => ({
      sha: `c${i}`, author: { login: 'me' },
      commit: { message: `m${i}`, author: { name: 'Me', date: '2026-01-01T00:00:00Z' } },
    }));
    const adapter = routedAdapter({
      '/repos/o/r': { default_branch: 'main' },
      '/repos/o/r/commits?sha=main&per_page=100&page=1': fullPage,
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const commits = await adapter.listCommits('o/r', { maxCommits: 2 });
      expect(commits).toHaveLength(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('reached the 2-commit cap'));
    } finally {
      warn.mockRestore();
    }
  });

  it('does NOT warn when commits are exhausted before the cap', async () => {
    const adapter = routedAdapter({
      '/repos/o/r': { default_branch: 'main' },
      '/repos/o/r/commits?sha=main&per_page=100&page=1': [
        { sha: 'c1', author: { login: 'me' }, commit: { message: 'init', author: { name: 'Me', date: '2026-01-01T00:00:00Z' } } },
      ],
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await adapter.listCommits('o/r', { maxCommits: 500 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('GitHubAdapter.listPullRequests shape guard', () => {
  it('throws GitHubResponseShapeError when the pulls response is not an array', async () => {
    const adapter = routedAdapter({
      '/repos/o/r/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1': { message: 'Moved Permanently', url: 'https://api.github.com/repositories/42' },
    });

    await expect(adapter.listPullRequests('o/r')).rejects.toBeInstanceOf(GitHubResponseShapeError);
  });
});

describe('GitHubAdapter.resolveById', () => {
  it('resolves a repo by immutable GitHub id to its current full_name', async () => {
    const adapter = routedAdapter({
      '/repositories/42': { id: 42, full_name: 'o/renamed', default_branch: 'main' },
    });

    await expect(adapter.resolveById(42)).resolves.toEqual({
      id: 42, fullName: 'o/renamed', defaultBranch: 'main',
    });
  });

  it('throws GitHubResponseShapeError when full_name is missing', async () => {
    const adapter = routedAdapter({ '/repositories/42': { id: 42 } });
    await expect(adapter.resolveById(42)).rejects.toBeInstanceOf(GitHubResponseShapeError);
  });
});

describe('GitHubAdapter.resolveByName', () => {
  it('resolves /repos/o/r to its current id, full_name and default_branch', async () => {
    // A renamed repo 301-redirects; `get` follows it, so even a stale name
    // surfaces the current identity. Here the body is already the resolved repo.
    const adapter = routedAdapter({
      '/repos/o/r': { id: 99, full_name: 'o/renamed', default_branch: 'main' },
    });

    await expect(adapter.resolveByName('o/r')).resolves.toEqual({
      id: 99, fullName: 'o/renamed', defaultBranch: 'main',
    });
  });

  it('throws GitHubResponseShapeError when full_name is missing', async () => {
    const adapter = routedAdapter({ '/repos/o/r': { id: 99 } });
    await expect(adapter.resolveByName('o/r')).rejects.toBeInstanceOf(GitHubResponseShapeError);
  });
});

describe('GitHubAdapter.getCommitDetail', () => {
    const route = (sha: string, body: unknown) => ({ [`/repos/o/r/commits/${sha}`]: body });

    it('maps commit stats and per-file changes', async () => {
        const adapter = routedAdapter(route('abc', {
            sha: 'abc',
            stats: { additions: 10, deletions: 3, total: 13 },
            files: [
                { filename: 'src/a.ts', status: 'modified', additions: 8, deletions: 3, changes: 11, patch: '@@ -1 +1 @@\n-old\n+new' },
                { filename: 'src/b.ts', status: 'added', additions: 2, deletions: 0, changes: 2, patch: '@@ +1 @@\n+x' },
            ],
        }));
        const d = await adapter.getCommitDetail('o/r', 'abc');
        expect(d).toMatchObject({ sha: 'abc', additions: 10, deletions: 3, filesChanged: 2 });
        expect(d.files[0]).toMatchObject({
            filePath: 'src/a.ts', status: 'modified', additions: 8, deletions: 3, changes: 11, patchTruncated: false,
        });
        expect(d.files[0].patch).toContain('+new');
    });

    it('caps an oversized per-file patch (drops patch, flags truncated)', async () => {
        const adapter = routedAdapter(route('big', {
            sha: 'big', stats: { additions: 1, deletions: 0 },
            files: [{ filename: 'f.ts', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: 'x'.repeat(200) }],
        }));
        const d = await adapter.getCommitDetail('o/r', 'big', { maxPatchBytes: 100 });
        expect(d.files[0].patch).toBeNull();
        expect(d.files[0].patchTruncated).toBe(true);
    });

    it('enforces a per-commit total patch budget', async () => {
        const p = 'y'.repeat(60);
        const adapter = routedAdapter(route('tot', {
            sha: 'tot', stats: {},
            files: [
                { filename: 'a', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: p },
                { filename: 'b', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: p },
            ],
        }));
        const d = await adapter.getCommitDetail('o/r', 'tot', { maxPatchBytes: 100, maxTotalPatchBytes: 100 });
        expect(d.files[0].patch).not.toBeNull();   // 60 bytes fits
        expect(d.files[1].patch).toBeNull();        // 60 + 60 > 100 → dropped
        expect(d.files[1].patchTruncated).toBe(true);
    });

    it('treats a GitHub-omitted patch (binary/large) as null, not truncated', async () => {
        const adapter = routedAdapter(route('bin', {
            sha: 'bin', stats: { additions: 0, deletions: 0 },
            files: [{ filename: 'img.png', status: 'added', additions: 0, deletions: 0, changes: 0 }],
        }));
        const d = await adapter.getCommitDetail('o/r', 'bin');
        expect(d.files[0].patch).toBeNull();
        expect(d.files[0].patchTruncated).toBe(false);
    });

    it('falls back to summing file stats when commit stats are absent', async () => {
        const adapter = routedAdapter(route('nostats', {
            sha: 'nostats',
            files: [{ filename: 'a', status: 'modified', additions: 4, deletions: 1, changes: 5, patch: '+a' }],
        }));
        const d = await adapter.getCommitDetail('o/r', 'nostats');
        expect(d).toMatchObject({ additions: 4, deletions: 1, filesChanged: 1 });
    });
});
