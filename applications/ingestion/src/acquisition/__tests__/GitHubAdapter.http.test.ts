/**
 * @format
 * GitHubAdapter HTTP layer — redirect following + 404 mapping.
 * The route-map seam (GitHubAdapter.test.ts) replaces `get` wholesale and so
 * cannot exercise the redirect/404 logic that lives *inside* `get`. Here we mock
 * the `https` module to drive that logic directly.
 *
 * Note: this workspace runs ts-jest in CommonJS mode, so we use the classic
 * hoisted `jest.mock` + static imports (no top-level `await import`).
 */
import { describe, it, expect, beforeEach } from '@jest/globals';
import { EventEmitter } from 'node:events';

import { GitHubAdapter } from '../GitHubAdapter.js';
import { RepoNotFoundError, GitHubResponseShapeError } from '@bedrock/shared';

// Each queued entry is the response for the next https.request call, in order.
type FakeResponse = { statusCode: number; headers: Record<string, string>; body: string };
const responseQueue: FakeResponse[] = [];
const requestedPaths: string[] = [];

jest.mock('https', () => ({
    __esModule: true,
    default: {
        request: (
            options: { path: string },
            cb: (res: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void,
        ) => {
            requestedPaths.push(options.path);
            const res = new EventEmitter() as EventEmitter & {
                statusCode: number;
                headers: Record<string, string>;
            };
            const next = responseQueue.shift() ?? { statusCode: 500, headers: {}, body: '' };
            res.statusCode = next.statusCode;
            res.headers = next.headers;
            const req = new EventEmitter() as EventEmitter & {
                end: () => void;
                setTimeout: (ms: number, cb?: () => void) => typeof req;
                destroy: (err?: Error) => typeof req;
            };
            // Model the real ClientRequest surface the adapter uses.
            req.setTimeout = () => req;
            req.destroy = (err?: Error) => { if (err) req.emit('error', err); return req; };
            req.end = () => {
                // Emit asynchronously, like the real socket.
                setImmediate(() => {
                    cb(res);
                    res.emit('data', Buffer.from(next.body));
                    res.emit('end');
                });
            };
            return req;
        },
    },
}));

// `get` is private; reach it through the same cast the route-map test uses.
function callGet(path: string): Promise<unknown> {
    const adapter = new GitHubAdapter('test-token');
    return (adapter as unknown as { get<T>(p: string): Promise<T> }).get(path);
}

beforeEach(() => {
    responseQueue.length = 0;
    requestedPaths.length = 0;
});

describe('GitHubAdapter.get redirect + 404 handling', () => {
    it('follows a 301 to the canonical /repositories/{id} and returns its body', async () => {
        responseQueue.push({ statusCode: 301, headers: { location: 'https://api.github.com/repositories/42' }, body: '{"message":"Moved Permanently"}' });
        responseQueue.push({ statusCode: 200, headers: {}, body: '{"id":42,"full_name":"o/renamed"}' });

        await expect(callGet('/repos/o/old')).resolves.toEqual({ id: 42, full_name: 'o/renamed' });
        expect(requestedPaths).toEqual(['/repos/o/old', '/repositories/42']);
    });

    it('throws RepoNotFoundError on a true 404', async () => {
        responseQueue.push({ statusCode: 404, headers: {}, body: '{"message":"Not Found"}' });
        await expect(callGet('/repos/o/missing')).rejects.toBeInstanceOf(RepoNotFoundError);
    });

    it('stops after the redirect cap and throws GitHubResponseShapeError', async () => {
        for (let i = 0; i < 5; i++) {
            responseQueue.push({ statusCode: 301, headers: { location: `https://api.github.com/loop/${i}` }, body: '{}' });
        }
        await expect(callGet('/repos/o/loop')).rejects.toBeInstanceOf(GitHubResponseShapeError);
    });
});
