/** @format */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

import { backfillDocTypes } from '../doc-type-backfill.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FileRow { file_path: string; content: string }

/**
 * A pool whose `query` dispatches on the SQL shape (DISTINCT repo scan vs.
 * per-repo file scan) and whose `connect` hands back one recording client for
 * the per-repo UPDATE transaction, mirroring RepoFactsRepository.test's
 * call-order assertion style.
 */
function makePool(opts: {
    repos?: string[];
    filesByRepo?: Record<string, FileRow[]>;
    onClientQuery?: (sql: string, params?: unknown[]) => void;
    failOnUpdate?: boolean;
}): { pool: Pool; clientQuery: jest.Mock; releaseSpy: jest.Mock } {
    const repos = opts.repos ?? [];
    const filesByRepo = opts.filesByRepo ?? {};

    const poolQuery = jest.fn<() => Promise<{ rows: unknown[] }>>().mockImplementation(async (...args: unknown[]) => {
        const sql = args[0] as string;
        const params = args[1] as unknown[] | undefined;
        if (/SELECT DISTINCT repo_full_name/i.test(sql)) {
            return { rows: repos.map((r) => ({ repo_full_name: r })) };
        }
        if (/SELECT file_path, content/i.test(sql)) {
            const repoFullName = params?.[1] as string;
            return { rows: filesByRepo[repoFullName] ?? [] };
        }
        return { rows: [] };
    });

    const releaseSpy = jest.fn();
    const clientQuery = jest.fn<() => Promise<{ rows: unknown[] }>>().mockImplementation(async (...args: unknown[]) => {
        const sql = args[0] as string;
        const params = args[1] as unknown[] | undefined;
        opts.onClientQuery?.(sql, params);
        if (opts.failOnUpdate && /^UPDATE document_embeddings/i.test(sql)) {
            throw new Error('boom');
        }
        return { rows: [] };
    });
    const client = { query: clientQuery, release: releaseSpy } as unknown as PoolClient;

    const pool = {
        query:   poolQuery,
        connect: jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
    } as unknown as Pool;

    return { pool, clientQuery, releaseSpy };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backfillDocTypes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('classifies each file and issues one jsonb_set UPDATE per file scoped to fileClass=docs', async () => {
        const calls: Array<[string, unknown[]?]> = [];
        const { pool } = makePool({
            repos: ['octo/repo'],
            filesByRepo: {
                'octo/repo': [
                    { file_path: 'README.md', content: '# hello' },
                    { file_path: 'docs/decisions/0001-use-postgres.md', content: '## Status\nAccepted' },
                ],
            },
            onClientQuery: (sql, params) => calls.push([sql, params]),
        });

        const result = await backfillDocTypes(pool, 'user-1');

        const updateCalls = calls.filter(([sql]) => /^UPDATE document_embeddings/i.test(sql));
        expect(updateCalls).toHaveLength(2);

        const [readmeSql, readmeParams] = updateCalls[0];
        expect(readmeSql).toMatch(/jsonb_set\(COALESCE\(metadata, '\{\}'::jsonb\), '\{docType\}', to_jsonb\(\$3::text\)\)/);
        expect(readmeSql).toMatch(/metadata->>'fileClass' = 'docs'/);
        expect(readmeParams).toEqual(['user-1', 'octo/repo', 'readme', 'README.md']);

        const [adrSql, adrParams] = updateCalls[1];
        expect(adrSql).toMatch(/UPDATE document_embeddings/);
        expect(adrParams).toEqual(['user-1', 'octo/repo', 'adr', 'docs/decisions/0001-use-postgres.md']);

        expect(result).toEqual({
            repos: 1,
            files: 2,
            byDocType: { readme: 1, adr: 1 },
        });
    });

    it('truncates content to the first 2000 characters before classifying', async () => {
        // Numbered filename outside any adr/runbook path segment, so only the
        // content sniff can turn this into 'adr' — and only if it sees the
        // '## Status' heading, which sits past the 2000-char slice boundary.
        const longContent = `${'x'.repeat(2100)}\n## Status\nAccepted`;
        const calls: Array<[string, unknown[]?]> = [];
        const { pool } = makePool({
            repos: ['octo/repo'],
            filesByRepo: {
                'octo/repo': [{ file_path: 'src/0001-x.md', content: longContent }],
            },
            onClientQuery: (sql, params) => calls.push([sql, params]),
        });

        const result = await backfillDocTypes(pool, 'user-1');

        expect(result.byDocType).toEqual({ doc: 1 });
        const updateCall = calls.find(([sql]) => /^UPDATE document_embeddings/i.test(sql));
        expect(updateCall?.[1]).toEqual(['user-1', 'octo/repo', 'doc', 'src/0001-x.md']);
    });

    it('wraps a repo\'s UPDATEs in BEGIN before / COMMIT after, in order', async () => {
        const calls: Array<[string, unknown[]?]> = [];
        const { pool } = makePool({
            repos: ['octo/repo'],
            filesByRepo: {
                'octo/repo': [
                    { file_path: 'README.md', content: '# hello' },
                    { file_path: 'CHANGELOG.md', content: '# changes' },
                ],
            },
            onClientQuery: (sql, params) => calls.push([sql, params]),
        });

        await backfillDocTypes(pool, 'user-1');

        const kinds = calls.map(([sql]) => {
            if (/^BEGIN/i.test(sql)) return 'BEGIN';
            if (/^UPDATE document_embeddings/i.test(sql)) return 'UPDATE';
            if (/^COMMIT/i.test(sql)) return 'COMMIT';
            if (/^ROLLBACK/i.test(sql)) return 'ROLLBACK';
            return 'OTHER';
        });
        expect(kinds).toEqual(['BEGIN', 'UPDATE', 'UPDATE', 'COMMIT']);
    });

    it('rolls back and rethrows when an UPDATE fails, and always releases the client', async () => {
        const { pool, releaseSpy } = makePool({
            repos: ['octo/repo'],
            filesByRepo: { 'octo/repo': [{ file_path: 'README.md', content: '# hello' }] },
            failOnUpdate: true,
        });

        await expect(backfillDocTypes(pool, 'user-1')).rejects.toThrow('boom');
        expect(releaseSpy).toHaveBeenCalledTimes(1);
    });

    it('scopes to the single repo when repoFullName is given, skipping the DISTINCT scan', async () => {
        const poolQuery = jest.fn<() => Promise<{ rows: unknown[] }>>().mockImplementation(async (...args: unknown[]) => {
            const sql = args[0] as string;
            if (/SELECT DISTINCT repo_full_name/i.test(sql)) {
                throw new Error('should not run the DISTINCT scan when repoFullName is given');
            }
            if (/SELECT file_path, content/i.test(sql)) {
                return { rows: [{ file_path: 'README.md', content: '# hello' }] };
            }
            return { rows: [] };
        });
        const client = {
            query:   jest.fn<() => Promise<{ rows: unknown[] }>>().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        } as unknown as PoolClient;
        const pool = {
            query:   poolQuery,
            connect: jest.fn<() => Promise<PoolClient>>().mockResolvedValue(client),
        } as unknown as Pool;

        const result = await backfillDocTypes(pool, 'user-1', 'octo/repo');

        expect(result).toEqual({ repos: 1, files: 1, byDocType: { readme: 1 } });
        const fileScan = (poolQuery.mock.calls as unknown as Array<[string, unknown[]?]>).find(
            ([sql]) => /SELECT file_path, content/i.test(sql),
        );
        expect(fileScan?.[1]).toEqual(['user-1', 'octo/repo']);
    });

    it('is idempotent: re-running issues the identical UPDATE params', async () => {
        const calls: Array<[string, unknown[]?]> = [];
        const { pool } = makePool({
            repos: ['octo/repo'],
            filesByRepo: { 'octo/repo': [{ file_path: 'README.md', content: '# hello' }] },
            onClientQuery: (sql, params) => calls.push([sql, params]),
        });

        await backfillDocTypes(pool, 'user-1');
        const first = calls.filter(([sql]) => /^UPDATE document_embeddings/i.test(sql)).map(([, params]) => params);

        calls.length = 0;
        await backfillDocTypes(pool, 'user-1');
        const second = calls.filter(([sql]) => /^UPDATE document_embeddings/i.test(sql)).map(([, params]) => params);

        expect(second).toEqual(first);
    });

    it('returns zero counts and no repos when there are no docs-lane chunks', async () => {
        const { pool } = makePool({ repos: [] });

        const result = await backfillDocTypes(pool, 'user-1');

        expect(result).toEqual({ repos: 0, files: 0, byDocType: {} });
    });
});
