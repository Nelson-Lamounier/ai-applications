// applications/shared/src/ingestion/implementations/GitHubAdapter.test.ts
import { describe, it, expect, jest } from '@jest/globals';
import https from 'https';
import { EventEmitter } from 'node:events';
import { GitHubAdapter } from './GitHubAdapter.js';

/**
 * Stubs https.request: returns a writable-ish ClientRequest that completes
 * with the supplied body + status when `req.end()` is called.
 */
function stubHttpsRequest(body: object, status = 200): {
    spy: { mockRestore: () => void };
    captured: { headers: Record<string, string> }[];
} {
    const captured: { headers: Record<string, string> }[] = [];
    const spy = jest.spyOn(https, 'request').mockImplementation((options: unknown, cb?: unknown) => {
        captured.push({ headers: (options as { headers: Record<string, string> }).headers });

        const res = new EventEmitter() as EventEmitter & { statusCode?: number };
        res.statusCode = status;
        const req = new EventEmitter() as EventEmitter & { end: () => void; write: () => void };
        req.end = (): void => {
            setImmediate(() => {
                (cb as (r: typeof res) => void)?.(res);
                res.emit('data', Buffer.from(JSON.stringify(body), 'utf-8'));
                res.emit('end');
            });
        };
        req.write = (): void => {};
        return req as unknown as ReturnType<typeof https.request>;
    });
    return { spy, captured };
}

describe('GitHubAdapter', () => {
    it('calls tokenProvider before each HTTPS request and forwards the token in Authorization', async () => {
        const tokens = ['t1', 't2', 't3'];
        let i = 0;
        const provider = jest.fn(async () => tokens[i++]!);

        const { spy, captured } = stubHttpsRequest({
            default_branch: 'main',
            tree: [{ path: 'README.md', type: 'blob', size: 100 }],
            truncated: false,
        });

        const adapter = new GitHubAdapter(provider as unknown as () => Promise<string>);
        await adapter.listFiles('owner/repo');

        // listFiles makes 2 calls: GET /repos/{repo} then GET /repos/{repo}/git/trees/...
        expect(provider).toHaveBeenCalledTimes(2);
        expect(captured[0]!.headers['Authorization']).toBe('Bearer t1');
        expect(captured[1]!.headers['Authorization']).toBe('Bearer t2');

        spy.mockRestore();
    });

    it('fromTokenString wraps a static token as a provider', async () => {
        const adapter = GitHubAdapter.fromTokenString('static-token');
        const { spy, captured } = stubHttpsRequest({
            default_branch: 'main',
            tree: [{ path: 'a.md', type: 'blob', size: 1 }],
            truncated: false,
        });

        await adapter.listFiles('owner/repo');
        expect(captured[0]!.headers['Authorization']).toBe('Bearer static-token');

        spy.mockRestore();
    });
});
