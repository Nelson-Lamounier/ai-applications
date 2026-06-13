/** @format */
import { deriveEvidenceTopology } from './evidence-topology.js';

const files = (...paths: string[]) => paths.map((path) => ({ path }));

describe('deriveEvidenceTopology — package.json scripts (manifest evidence)', () => {
    it('detects real test/lint/build/typecheck scripts', () => {
        const t = deriveEvidenceTopology([], {
            scripts: { test: 'vitest run', lint: 'eslint .', build: 'tsc -p .', typecheck: 'tsc --noEmit' },
        });
        expect(t).toMatchObject({ has_test_script: true, has_lint_script: true, has_build_script: true, has_typecheck_script: true });
    });

    it('ignores the npm placeholder test script', () => {
        const t = deriveEvidenceTopology([], { scripts: { test: 'echo "Error: no test specified" && exit 1' } });
        expect(t.has_test_script).toBe(false);
    });

    it('detects typecheck via an inline tsc --noEmit even without a named script', () => {
        const t = deriveEvidenceTopology([], { scripts: { check: 'tsc --noEmit && eslint .' } });
        expect(t.has_typecheck_script).toBe(true);
    });

    it('no scripts → all false', () => {
        const t = deriveEvidenceTopology([], {});
        expect(t).toMatchObject({ has_test_script: false, has_lint_script: false, has_build_script: false });
    });
});

describe('deriveEvidenceTopology — migrations across ALL DB ecosystems', () => {
    const cases: Array<[string, ReturnType<typeof files>, Record<string, unknown> | null, string]> = [
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
        const t = deriveEvidenceTopology(fs, pkg);
        expect(t.has_migrations).toBe(true);
        expect(t.migration_tools).toContain(tool);
    });

    it('drops the generic sql-migrations catch-all when a specific tool matches', () => {
        const t = deriveEvidenceTopology(files('prisma/migrations/1/migration.sql', 'db/migrations/2.sql'), { dependencies: { prisma: '^5' } });
        expect(t.migration_tools).toContain('prisma');
        expect(t.migration_tools).not.toContain('sql-migrations');
    });

    it('no migration system → has_migrations false', () => {
        const t = deriveEvidenceTopology(files('src/index.ts', 'README.md'), { scripts: { build: 'tsc' } });
        expect(t.has_migrations).toBe(false);
        expect(t.migration_tools).toEqual([]);
    });
});

describe('deriveEvidenceTopology — monorepo', () => {
    it('detects workspaces field', () => {
        expect(deriveEvidenceTopology([], { workspaces: ['packages/*'] }).is_monorepo).toBe(true);
    });
    it('detects ≥2 nested package.json', () => {
        expect(deriveEvidenceTopology(files('packages/a/package.json', 'packages/b/package.json'), null).is_monorepo).toBe(true);
    });
    it('detects a workspace config file (turbo/nx/pnpm/lerna)', () => {
        expect(deriveEvidenceTopology(files('turbo.json'), null).is_monorepo).toBe(true);
    });
    it('single package → not a monorepo', () => {
        expect(deriveEvidenceTopology(files('package.json', 'src/index.ts'), {}).is_monorepo).toBe(false);
    });
});
