/** @format */
import { deriveEvidenceTopology } from '../evidence-topology.js';

const files = (...paths: string[]) => paths.map((path) => ({ path }));
type Manifest = Record<string, unknown> | null;
const one = (pkg: Manifest) => [pkg]; // single-package repo

describe('deriveEvidenceTopology — package.json scripts (manifest evidence)', () => {
    it('detects real test/lint/build/typecheck scripts', () => {
        const t = deriveEvidenceTopology([], one({
            scripts: { test: 'vitest run', lint: 'eslint .', build: 'tsc -p .', typecheck: 'tsc --noEmit' },
        }));
        expect(t).toMatchObject({ has_test_script: true, has_lint_script: true, has_build_script: true, has_typecheck_script: true });
    });

    it('ignores the npm placeholder test script', () => {
        const t = deriveEvidenceTopology([], one({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
        expect(t.has_test_script).toBe(false);
    });

    it('detects typecheck via an inline tsc --noEmit even without a named script', () => {
        const t = deriveEvidenceTopology([], one({ scripts: { check: 'tsc --noEmit && eslint .' } }));
        expect(t.has_typecheck_script).toBe(true);
    });

    it('MONOREPO: scripts in a workspace package count (root has none)', () => {
        const t = deriveEvidenceTopology(
            files('package.json', 'packages/api/package.json'),
            [
                { workspaces: ['packages/*'] },                                  // root: no scripts
                { scripts: { test: 'jest', build: 'tsc -b' } },                  // workspace package: scripts
            ],
        );
        expect(t).toMatchObject({ has_test_script: true, has_build_script: true, is_monorepo: true });
    });

    it('no scripts in any manifest → all false', () => {
        const t = deriveEvidenceTopology([], [{}, { workspaces: ['x'] }]);
        expect(t).toMatchObject({ has_test_script: false, has_lint_script: false, has_build_script: false });
    });
});

describe('deriveEvidenceTopology — primary language', () => {
    it('picks the dominant source language by file count', () => {
        const t = deriveEvidenceTopology(
            files('src/a.ts', 'src/b.ts', 'src/c.ts', 'scripts/x.py', 'README.md'),
            [null],
        );
        expect(t.primary_language).toBe('TypeScript');
        expect(t.language_breakdown).toMatchObject({ TypeScript: 3, Python: 1 });
    });

    it('ignores docs/config/data files when choosing the language', () => {
        const t = deriveEvidenceTopology(
            files('main.go', 'go.mod', 'README.md', 'config.yaml', 'data/seed.csv'),
            [null],
        );
        expect(t.primary_language).toBe('Go');
        expect(t.language_breakdown.Go).toBe(1);
    });

    it('maps several ecosystems (Rust, Java, C#, HCL, SQL)', () => {
        const t = deriveEvidenceTopology(
            files('lib.rs', 'lib2.rs', 'App.java', 'Program.cs', 'main.tf', 'q.sql'),
            [null],
        );
        expect(t.primary_language).toBe('Rust');
        expect(t.language_breakdown).toMatchObject({ Rust: 2, Java: 1, 'C#': 1, HCL: 1, SQL: 1 });
    });

    it('returns null primary_language for a docs-only repo', () => {
        const t = deriveEvidenceTopology(files('README.md', 'docs/x.md'), [null]);
        expect(t.primary_language).toBeNull();
        expect(t.language_breakdown).toEqual({});
    });

    it('breaks ties deterministically (alphabetical)', () => {
        const t = deriveEvidenceTopology(files('a.go', 'b.py'), [null]);
        expect(t.primary_language).toBe('Go'); // Go < Python
    });
});

describe('deriveEvidenceTopology — migrations across ALL DB ecosystems', () => {
    const cases: Array<[string, ReturnType<typeof files>, Manifest, string]> = [
        ['raw SQL', files('db/migrations/001_init.sql'), null, 'sql-migrations'],
        ['Prisma (path)', files('prisma/migrations/20240101_init/migration.sql'), null, 'prisma'],
        ['Prisma (schema)', files('prisma/schema.prisma'), null, 'prisma'],
        ['Prisma (dep)', files('src/db.ts'), { dependencies: { '@prisma/client': '^5' } }, 'prisma'],
        ['TypeORM (dep)', files('src/migration/Init.ts'), { dependencies: { typeorm: '^0.3' } }, 'typeorm'],
        ['Sequelize (dep)', files('migrations/x.js'), { dependencies: { sequelize: '^6' } }, 'sequelize'],
        ['Knex (knexfile)', files('knexfile.ts', 'migrations/001.ts'), null, 'knex'],
        ['Drizzle (config)', files('drizzle.config.ts'), { devDependencies: { 'drizzle-kit': '^0.2' } }, 'drizzle'],
        ['Alembic', files('alembic/versions/abc_init.py', 'alembic.ini'), null, 'alembic'],
        ['Django', files('app/migrations/0001_initial.py', 'manage.py'), null, 'django'],
        ['Rails', files('db/migrate/20240101000000_create_users.rb'), null, 'rails'],
        ['Flyway', files('src/main/resources/db/migration/V1__init.sql'), null, 'flyway'],
        ['Liquibase', files('src/db/changelog.xml'), null, 'liquibase'],
        ['EF Core', files('Migrations/20240101_Init.cs'), null, 'ef-core'],
        ['Laravel', files('database/migrations/2024_01_01_000000_create_users_table.php'), null, 'laravel'],
        ['migrate-mongo', files('migrations/x.js'), { dependencies: { 'migrate-mongo': '^9' } }, 'migrate-mongo'],
    ];

    it.each(cases)('detects %s migrations → %s', (_label, fs, pkg, tool) => {
        const t = deriveEvidenceTopology(fs, one(pkg));
        expect(t.has_migrations).toBe(true);
        expect(t.migration_tools).toContain(tool);
    });

    it('drops the generic sql-migrations catch-all when a specific tool matches', () => {
        const t = deriveEvidenceTopology(files('prisma/migrations/1/migration.sql', 'db/migrations/2.sql'), one({ dependencies: { prisma: '^5' } }));
        expect(t.migration_tools).toContain('prisma');
        expect(t.migration_tools).not.toContain('sql-migrations');
    });

    it('no migration system → has_migrations false', () => {
        const t = deriveEvidenceTopology(files('src/index.ts', 'README.md'), one({ scripts: { build: 'tsc' } }));
        expect(t.has_migrations).toBe(false);
        expect(t.migration_tools).toEqual([]);
    });
});

describe('deriveEvidenceTopology — monorepo', () => {
    it('detects workspaces field', () => {
        expect(deriveEvidenceTopology([], one({ workspaces: ['packages/*'] })).is_monorepo).toBe(true);
    });
    it('detects ≥2 nested package.json', () => {
        expect(deriveEvidenceTopology(files('packages/a/package.json', 'packages/b/package.json'), [null]).is_monorepo).toBe(true);
    });
    it('detects a workspace config file (turbo/nx/pnpm/lerna)', () => {
        expect(deriveEvidenceTopology(files('turbo.json'), [null]).is_monorepo).toBe(true);
    });
    it('single package → not a monorepo', () => {
        expect(deriveEvidenceTopology(files('package.json', 'src/index.ts'), one({})).is_monorepo).toBe(false);
    });
});
