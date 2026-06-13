/**
 * @format
 * Evidence topology — deterministic, high-signal repo facts derived BEFORE any LLM
 * call from the FULL file tree + parsed package.json. Evidence (real files +
 * manifest scripts), never README claims; no I/O, no clock, no randomness.
 *
 * Two gaps this closes vs the path-only archetype signals:
 *   1. package.json SCRIPTS — a real test/lint/build/typecheck script is manifest
 *      evidence of engineering rigor (stronger than a README claim).
 *   2. DATABASE MIGRATIONS — detected GENERICALLY across ecosystems (raw SQL,
 *      Prisma, TypeORM, Sequelize, Knex, Drizzle, node-pg-migrate, Alembic, Django,
 *      Rails/ActiveRecord, Flyway, Liquibase, Go migrate/goose/atlas, dbmate,
 *      EF Core, Laravel, Phinx, migrate-mongo) — not a single user's SQL layout.
 */

export interface EvidenceTopology {
    /** package.json scripts present (real, non-placeholder). */
    readonly has_test_script: boolean;
    readonly has_lint_script: boolean;
    readonly has_build_script: boolean;
    readonly has_typecheck_script: boolean;
    /** Any database migration system detected (path or dependency). */
    readonly has_migrations: boolean;
    /** The migration tool(s) identified — for honest, specific framing. */
    readonly migration_tools: string[];
    /** Workspaces/nested-manifest monorepo. */
    readonly is_monorepo: boolean;
}

/** A migration ecosystem: detected by file-path patterns and/or package.json deps. */
interface MigrationTool {
    readonly name: string;
    readonly paths?: readonly RegExp[];
    readonly deps?: readonly string[];
}

// Ordered most-specific-first so a tool's own dir wins over the generic `migrations/`.
const MIGRATION_TOOLS: readonly MigrationTool[] = [
    { name: 'prisma',         paths: [/(?:^|\/)prisma\/migrations\//i, /(?:^|\/)schema\.prisma$/i], deps: ['prisma', '@prisma/client'] },
    { name: 'drizzle',        paths: [/(?:^|\/)drizzle\.config\.[jt]s$/i, /(?:^|\/)drizzle\//i], deps: ['drizzle-orm', 'drizzle-kit'] },
    { name: 'typeorm',        paths: [/(?:^|\/)ormconfig\.[^/]+$/i], deps: ['typeorm'] },
    { name: 'sequelize',      paths: [/(?:^|\/)\.sequelizerc$/i], deps: ['sequelize', 'sequelize-cli'] },
    { name: 'knex',           paths: [/(?:^|\/)knexfile\.[jt]s$/i], deps: ['knex'] },
    { name: 'node-pg-migrate', deps: ['node-pg-migrate'] },
    { name: 'mikro-orm',      deps: ['@mikro-orm/core', '@mikro-orm/cli'] },
    { name: 'migrate-mongo',  deps: ['migrate-mongo'] },
    { name: 'alembic',        paths: [/(?:^|\/)alembic\.ini$/i, /(?:^|\/)alembic\/versions\//i] },
    { name: 'django',         paths: [/(?:^|\/)[^/]+\/migrations\/\d{4}_[^/]*\.py$/i, /(?:^|\/)manage\.py$/i] },
    { name: 'rails',          paths: [/(?:^|\/)db\/migrate\/\d+_[^/]*\.rb$/i, /(?:^|\/)db\/schema\.rb$/i] },
    { name: 'flyway',         paths: [/(?:^|\/)(?:db\/migration|sql)\/V\d+__[^/]*\.sql$/i, /(?:^|\/)flyway\.conf$/i] },
    { name: 'liquibase',      paths: [/(?:^|\/)[^/]*changelog[^/]*\.(?:xml|ya?ml|json|sql)$/i, /(?:^|\/)liquibase\.properties$/i] },
    { name: 'atlas',          paths: [/(?:^|\/)atlas\.hcl$/i] },
    { name: 'ef-core',        paths: [/(?:^|\/)Migrations\/[^/]*\.cs$/i, /(?:^|\/)[^/]*ModelSnapshot\.cs$/i] },
    { name: 'laravel',        paths: [/(?:^|\/)database\/migrations\/\d{4}_[^/]*\.php$/i] },
    { name: 'phinx',          paths: [/(?:^|\/)phinx\.(?:yml|php)$/i] },
    // Generic fallback: a migrations/ dir of versioned SQL/TS/JS/Go files (incl. the
    // up/down split used by golang-migrate, goose, dbmate — indistinguishable by path,
    // so reported honestly as generic SQL migrations rather than a guessed tool).
    { name: 'sql-migrations', paths: [/(?:^|\/)(?:db\/)?migrations?\/[^/]*\.(?:sql|ts|js|go)$/i, /\.(?:up|down)\.sql$/i] },
];

const NESTED_PKG_RE = /\/package\.json$/i;
const WORKSPACE_FILE_RE = /(?:^|\/)(?:pnpm-workspace\.ya?ml|nx\.json|turbo\.json|lerna\.json)$/i;
/** npm's placeholder test script — counts as NO real test script. */
const PLACEHOLDER_TEST = /no test specified/i;

function scriptsOf(pkg: Record<string, unknown> | null | undefined): Record<string, string> {
    const s = pkg?.scripts;
    if (s == null || typeof s !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
        if (typeof v === 'string') out[k.toLowerCase()] = v.toLowerCase();
    }
    return out;
}

function depNamesOf(pkg: Record<string, unknown> | null | undefined): Set<string> {
    const names = new Set<string>();
    if (!pkg) return names;
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
        const group = pkg[key];
        if (group != null && typeof group === 'object') {
            for (const dep of Object.keys(group)) names.add(dep.toLowerCase());
        }
    }
    return names;
}

/** Detect every migration ecosystem present, by path patterns and/or deps. */
function detectMigrationTools(paths: readonly string[], deps: ReadonlySet<string>): string[] {
    const found = new Set<string>();
    for (const tool of MIGRATION_TOOLS) {
        const byPath = tool.paths?.some((re) => paths.some((p) => re.test(p))) ?? false;
        const byDep = tool.deps?.some((d) => deps.has(d)) ?? false;
        if (byPath || byDep) found.add(tool.name);
    }
    // If a specific tool matched, drop the generic sql-migrations catch-all.
    if (found.size > 1) found.delete('sql-migrations');
    return [...found];
}

/** A script entry that is present, non-empty, and not the npm placeholder. */
function hasRealScript(scripts: Record<string, string>, name: string): boolean {
    const v = scripts[name];
    return typeof v === 'string' && v.length > 0 && !PLACEHOLDER_TEST.test(v);
}

export function deriveEvidenceTopology(
    files: readonly { path: string }[],
    packageJson: Record<string, unknown> | null,
): EvidenceTopology {
    const paths = files.map((f) => f.path);
    const scripts = scriptsOf(packageJson);
    const deps = depNamesOf(packageJson);

    const migrationTools = detectMigrationTools(paths, deps);
    const nestedPkgCount = paths.filter((p) => NESTED_PKG_RE.test(p)).length;
    const hasWorkspaceField = packageJson?.workspaces != null;

    return {
        has_test_script: hasRealScript(scripts, 'test'),
        has_lint_script: hasRealScript(scripts, 'lint'),
        has_build_script: hasRealScript(scripts, 'build'),
        // typecheck: an explicit script, or a `tsc`-based check anywhere in scripts.
        has_typecheck_script: hasRealScript(scripts, 'typecheck') || hasRealScript(scripts, 'type-check') ||
            Object.values(scripts).some((cmd) => /\btsc\b.*--noemit|--noemit.*\btsc\b|\btsc --noemit\b/.test(cmd)),
        has_migrations: migrationTools.length > 0,
        migration_tools: migrationTools.toSorted((a, b) => a.localeCompare(b)),
        is_monorepo: nestedPkgCount >= 2 || hasWorkspaceField || paths.some((p) => WORKSPACE_FILE_RE.test(p)),
    };
}
