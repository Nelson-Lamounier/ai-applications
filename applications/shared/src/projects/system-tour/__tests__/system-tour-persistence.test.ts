/**
 * @format
 * RdsSystemTourRepository — one tour per project (project_id UNIQUE).
 * Mirrors the dsa-evidence repo's RLS mechanism: every call runs through
 * `withUserRls`, which demotes to `tucaken_app` and stamps
 * `SELECT set_config('app.current_user_id', $1, true)` in the same
 * transaction so the project_system_tours RLS policy
 * (USING user_id = current_setting(...)) lets the write/read through.
 * Verified against a fakePool.
 */
import { describe, it, expect, jest } from '@jest/globals';

import { RdsSystemTourRepository } from '../system-tour-persistence.js';
import type { SystemTour } from '../system-tour-types.js';

const sampleTour: SystemTour = {
    area:    'Ingestion pipeline',
    context: 'Sync GitHub repos into the projects domain.',
    keyDecisions: [{ decision: 'Use a watermark', rationale: 'Avoid re-fetch' }],
    tradeoffs:    [],
    systemMap: {
        diagramFormat: 'mermaid',
        diagramSource: 'graph TD; a-->b',
        nodes: [],
        edges: [],
    },
    outcomes:     [],
    whatIdChange: [],
};

describe('RdsSystemTourRepository.upsert', () => {
    it('sets the user scope and runs the ON CONFLICT (project_id) insert', async () => {
        const query = jest.fn(async () => ({ rows: [], rowCount: 0 }));
        const client = { query, release: jest.fn() };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pool = { connect: jest.fn(async () => client) } as any;

        await new RdsSystemTourRepository(pool).upsert('u1', 'p1', sampleTour, 'hash-1');

        const sql = query.mock.calls.map((c) => (c as unknown[])[0] as string);
        expect(sql.some((s) => /BEGIN/.test(s))).toBe(true);
        expect(sql.some((s) => s === 'SET LOCAL ROLE tucaken_app')).toBe(true);
        expect(sql.some((s) => /set_config\('app.current_user_id'/.test(s))).toBe(true);
        expect(
            sql.some(
                (s) =>
                    /INSERT INTO project_system_tours/.test(s) &&
                    /ON CONFLICT \(project_id\) DO UPDATE/.test(s),
            ),
        ).toBe(true);
        expect(sql.some((s) => /COMMIT/.test(s))).toBe(true);

        // Content is serialised to JSON; hash is passed verbatim.
        const insertCall = query.mock.calls.find((c) =>
            /INSERT INTO project_system_tours/.test((c as unknown[])[0] as string),
        ) as unknown[];
        const params = insertCall[1] as unknown[];
        expect(params[0]).toBe('u1');
        expect(params[1]).toBe('p1');
        expect(params[2]).toBe(JSON.stringify(sampleTour));
        expect(params[3]).toBe('hash-1');

        expect(client.release).toHaveBeenCalled();
    });

    it('rolls back on a query error and re-throws', async () => {
        const query = jest.fn(async (sql: unknown) => {
            if (/INSERT INTO project_system_tours/.test(String(sql))) {
                throw new Error('boom');
            }
            return { rows: [], rowCount: 0 };
        });
        const client = { query, release: jest.fn() };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pool = { connect: jest.fn(async () => client) } as any;

        await expect(
            new RdsSystemTourRepository(pool).upsert('u1', 'p1', sampleTour, 'h'),
        ).rejects.toThrow('boom');

        const sql = query.mock.calls.map((c) => (c as unknown[])[0] as string);
        expect(sql.some((s) => /ROLLBACK/.test(s))).toBe(true);
        expect(client.release).toHaveBeenCalled();
    });
});

describe('RdsSystemTourRepository.getForProject', () => {
    it('round-trips a stored tour (user-scoped SELECT, JSON.parse content)', async () => {
        const query = jest.fn(async (sql: unknown) =>
            /SELECT content FROM project_system_tours/.test(String(sql))
                ? { rows: [{ content: JSON.stringify(sampleTour) }] }
                : { rows: [] },
        );
        const client = { query, release: jest.fn() };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pool = { connect: jest.fn(async () => client) } as any;

        const out = await new RdsSystemTourRepository(pool).getForProject('u1', 'p1');
        expect(out).toEqual(sampleTour);

        const sql = query.mock.calls.map((c) => (c as unknown[])[0] as string);
        expect(sql.some((s) => s === 'SET LOCAL ROLE tucaken_app')).toBe(true);
        expect(sql.some((s) => /set_config\('app.current_user_id'/.test(s))).toBe(true);
    });

    it('handles a pre-parsed JSONB object (driver may return an object)', async () => {
        const query = jest.fn(async (sql: unknown) =>
            /SELECT content FROM project_system_tours/.test(String(sql))
                ? { rows: [{ content: sampleTour }] }
                : { rows: [] },
        );
        const client = { query, release: jest.fn() };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pool = { connect: jest.fn(async () => client) } as any;

        expect(await new RdsSystemTourRepository(pool).getForProject('u1', 'p1')).toEqual(
            sampleTour,
        );
    });

    it('returns null when no row exists', async () => {
        const query = jest.fn(async () => ({ rows: [] }));
        const client = { query, release: jest.fn() };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pool = { connect: jest.fn(async () => client) } as any;

        expect(await new RdsSystemTourRepository(pool).getForProject('u1', 'p1')).toBeNull();
    });
});
