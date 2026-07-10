/**
 * @format
 * Regression guard for loadProjectResumeBulletsBlock — the per-user RLS read of
 * project_resume_bullets MUST set `app.current_user_id` in the same transaction
 * (via withUserRls), or pgbouncer transaction-pooling leaves the GUC unset and
 * RLS silently returns 0 rows (live symptom: projects[].highlights never
 * populated despite the user having bullet evidence).
 */
import { describe, it, expect, jest } from '@jest/globals';
import type { Pool } from 'pg';
import { loadProjectResumeBulletsBlock } from './project-evidence-block.js';

/** Mock pool whose connect() returns a client; the SELECT resolves given rows. */
function mockPool(selectRows: Array<{ name: string; angle: string; bullets: unknown }>) {
    const release = jest.fn();
    const query = jest.fn<(sql: string) => Promise<{ rows: unknown[] }>>().mockImplementation((sql) =>
        Promise.resolve(/FROM project_resume_bullets/i.test(sql) ? { rows: selectRows } : { rows: [] }),
    );
    const connect = jest.fn<() => Promise<{ query: typeof query; release: typeof release }>>()
        .mockResolvedValue({ query, release });
    return { pool: { connect } as unknown as Pool, connect, query, release };
}

describe('loadProjectResumeBulletsBlock — RLS-scoped read', () => {
    it('sets app.current_user_id in the same transaction before the SELECT', async () => {
        const { pool, connect, query, release } = mockPool([
            { name: 'Tucaken', angle: 'infrastructure', bullets: ['Provisioned EKS with Karpenter autoscaling'] },
        ]);
        const block = await loadProjectResumeBulletsBlock(pool, '1d4c645a-447e-4b5b-924d-19a3c75a84db');

        expect(connect).toHaveBeenCalledTimes(1); // dedicated client, not a bare pool.query
        const sqls = query.mock.calls.map((c) => c[0] as string);
        expect(sqls).toEqual(expect.arrayContaining([
            'BEGIN',
            expect.stringMatching(/set_config\('app\.current_user_id'/),
            expect.stringMatching(/FROM project_resume_bullets/),
            'COMMIT',
        ]));
        // GUC set before the SELECT.
        const gucIdx = sqls.findIndex((s) => /set_config\('app\.current_user_id'/.test(s));
        const selIdx = sqls.findIndex((s) => /FROM project_resume_bullets/.test(s));
        expect(gucIdx).toBeGreaterThanOrEqual(0);
        expect(gucIdx).toBeLessThan(selIdx);
        expect(release).toHaveBeenCalledTimes(1);

        // Formats the block by project + angle.
        expect(block).toContain('## Tucaken');
        expect(block).toContain('[angle: infrastructure]');
        expect(block).toContain('- Provisioned EKS with Karpenter autoscaling');
    });

    it('fails open to empty string when no bullets exist (no highlights demanded)', async () => {
        const { pool } = mockPool([]);
        const block = await loadProjectResumeBulletsBlock(pool, 'no-bullets-user');
        expect(block).toBe('');
    });
});
