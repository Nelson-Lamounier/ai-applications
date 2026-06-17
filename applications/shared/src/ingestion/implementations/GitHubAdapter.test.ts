/**
 * @format
 * GitHubAdapter — blob-SHA surfacing + HEAD-commit gate
 *
 * The adapter's HTTP layer is a private `get<T>(path)` helper. We intercept it
 * with a tiny subclass that resolves a route map instead of hitting the network.
 * This keeps the tests hermetic and faithful to the adapter's real call shapes.
 */

import { describe, it, expect } from '@jest/globals';

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
});
