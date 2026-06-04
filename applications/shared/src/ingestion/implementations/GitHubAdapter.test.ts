/**
 * @format
 * GitHubAdapter — blob-SHA surfacing + HEAD-commit gate
 *
 * The adapter's HTTP layer is a private `get<T>(path)` helper. We intercept it
 * with a tiny subclass that resolves a route map instead of hitting the network.
 * This keeps the tests hermetic and faithful to the adapter's real call shapes.
 */

import { EventEmitter } from 'node:events';
import https from 'https';
import { describe, it, expect, jest, afterEach } from '@jest/globals';

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

describe('GitHubAdapter HTTPS guardrails', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('rejects responses that exceed the configured byte cap', async () => {
        jest.spyOn(https, 'request').mockImplementation(((_options: unknown, cb: (res: EventEmitter & { statusCode?: number }) => void) => {
            const req = new EventEmitter() as EventEmitter & {
                end: () => void;
                setTimeout: () => void;
                destroy: (err?: Error) => void;
            };
            req.setTimeout = jest.fn();
            req.destroy = jest.fn((err?: Error) => {
                if (err) req.emit('error', err);
            });
            req.end = () => {
                const res = new EventEmitter() as EventEmitter & { statusCode?: number };
                res.statusCode = 200;
                cb(res);
                res.emit('data', Buffer.alloc(6));
            };
            return req;
        }) as never);

        const adapter = new GitHubAdapter('token', { maxResponseBytes: 5 });

        await expect(
            (adapter as unknown as { get<T>(path: string): Promise<T> }).get('/repos/o/r'),
        ).rejects.toThrow(/too large/i);
    });

    it('times out stalled GitHub requests', async () => {
        jest.spyOn(https, 'request').mockImplementation(((_options: unknown, _cb: unknown) => {
            const req = new EventEmitter() as EventEmitter & {
                end: () => void;
                setTimeout: (ms: number, cb: () => void) => void;
                destroy: (err?: Error) => void;
            };
            let timeout: (() => void) | undefined;
            req.setTimeout = jest.fn((_ms: number, cb: () => void) => { timeout = cb; });
            req.destroy = jest.fn((err?: Error) => {
                if (err) req.emit('error', err);
            });
            req.end = () => { timeout?.(); };
            return req;
        }) as never);

        const adapter = new GitHubAdapter('token', { requestTimeoutMs: 1 });

        await expect(
            (adapter as unknown as { get<T>(path: string): Promise<T> }).get('/repos/o/r'),
        ).rejects.toThrow(/timed out/i);
    });
});
