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
