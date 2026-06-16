/** @format */
import {
    checksum,
    decideMigration,
    applyMigrations,
    type QueryClient,
} from './bootstrap';

// ─── A mock pg client that records queries and answers the runner's reads ──────

interface Row { name: string; checksum: string }

class FakeClient implements QueryClient {
    readonly queries: { text: string; values?: unknown[] }[] = [];
    readonly recorded = new Map<string, string>();

    constructor(
        private readonly tables: Set<string>,
        private readonly ledgerRows: Row[] = [],
    ) {}

    async query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> {
        this.queries.push({ text, values });
        if (text.includes('to_regclass')) {
            const t = String(values?.[0]);
            return { rows: [{ reg: this.tables.has(t) ? t : null }] };
        }
        if (text.includes('FROM schema_migrations')) {
            return { rows: this.ledgerRows as unknown as Array<Record<string, unknown>> };
        }
        if (text.includes('INSERT INTO schema_migrations')) {
            this.recorded.set(String(values?.[0]), String(values?.[1]));
            return { rows: [] };
        }
        return { rows: [] };
    }

    ranSql(sql: string): boolean {
        return this.queries.some((q) => q.text === sql);
    }
}

const MIGRATIONS = [
    { name: '001_a.sql', sql: 'SQL_A' },
    { name: '002_b.sql', sql: 'SQL_B' },
];

describe('checksum', () => {
    it('is deterministic and distinguishes different SQL', () => {
        expect(checksum('SQL_A')).toBe(checksum('SQL_A'));
        expect(checksum('SQL_A')).not.toBe(checksum('SQL_B'));
    });
});

describe('decideMigration', () => {
    it('applies when never recorded', () => {
        expect(decideMigration(checksum('x'), undefined)).toBe('apply');
    });
    it('skips when recorded with the same checksum', () => {
        expect(decideMigration(checksum('x'), checksum('x'))).toBe('skip');
    });
    it('rejects when recorded with a different checksum (edited history)', () => {
        expect(decideMigration(checksum('x'), checksum('y'))).toBe('reject');
    });
});

describe('applyMigrations', () => {
    it('fresh database — applies every migration and records each', async () => {
        const c = new FakeClient(new Set()); // no schema_migrations, no users
        await applyMigrations(c, MIGRATIONS);
        expect(c.ranSql('SQL_A')).toBe(true);
        expect(c.ranSql('SQL_B')).toBe(true);
        expect(c.recorded.get('001_a.sql')).toBe(checksum('SQL_A'));
        expect(c.recorded.get('002_b.sql')).toBe(checksum('SQL_B'));
    });

    it('existing database without a ledger — BASELINES (records without running)', async () => {
        const c = new FakeClient(new Set(['users'])); // schema present, ledger absent
        await applyMigrations(c, MIGRATIONS);
        expect(c.ranSql('SQL_A')).toBe(false); // never re-runs a historical migration
        expect(c.ranSql('SQL_B')).toBe(false);
        expect(c.recorded.get('001_a.sql')).toBe(checksum('SQL_A')); // but recorded as applied
        expect(c.recorded.get('002_b.sql')).toBe(checksum('SQL_B'));
    });

    it('already-applied migrations are skipped on a normal run', async () => {
        const c = new FakeClient(
            new Set(['schema_migrations', 'users']),
            [
                { name: '001_a.sql', checksum: checksum('SQL_A') },
                { name: '002_b.sql', checksum: checksum('SQL_B') },
            ],
        );
        await applyMigrations(c, MIGRATIONS);
        expect(c.ranSql('SQL_A')).toBe(false);
        expect(c.ranSql('SQL_B')).toBe(false);
        expect(c.recorded.size).toBe(0);
    });

    it('rejects a historical migration whose checksum changed', async () => {
        const c = new FakeClient(
            new Set(['schema_migrations', 'users']),
            [{ name: '001_a.sql', checksum: 'STALE_CHECKSUM' }],
        );
        await expect(applyMigrations(c, MIGRATIONS)).rejects.toThrow(/edited after it was applied/);
        expect(c.ranSql('SQL_A')).toBe(false); // not applied — rejected before running
    });

    it('applies only the new migration when the ledger covers the rest', async () => {
        const c = new FakeClient(
            new Set(['schema_migrations', 'users']),
            [{ name: '001_a.sql', checksum: checksum('SQL_A') }], // 002 is new
        );
        await applyMigrations(c, MIGRATIONS);
        expect(c.ranSql('SQL_A')).toBe(false); // already applied → skipped
        expect(c.ranSql('SQL_B')).toBe(true);  // new → applied
        expect(c.recorded.get('002_b.sql')).toBe(checksum('SQL_B'));
    });
});
