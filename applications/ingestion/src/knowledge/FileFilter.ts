/**
 * @format
 * FileFilter — IFileFilter backed by glob pattern matching
 *
 * Pure class — no I/O, no async, no external dependencies.
 * Compile once, call many times. All logic lives in shouldInclude().
 *
 * Pattern syntax (subset of standard glob):
 *   *         matches any characters within a single path segment
 *   **        matches any characters across path segments (zero or more)
 *   ?         matches any single character within a path segment
 *   *.md      matches any .md file at the root level only
 *   **∕*.md   matches any .md file at any depth
 *
 * Evaluation order:
 *   1. If path matches any exclude pattern → excluded
 *   2. If path matches any include pattern → included
 *   3. Otherwise → excluded
 *
 * Exclude takes priority over include (matches .gitignore semantics).
 */

import type { IFileFilter } from './IFileFilter.js';

// =============================================================================
// GLOB MATCHING
// =============================================================================

/**
 * Compile a glob pattern string into a RegExp.
 * Handles: `*`, `**`, `**\/`, and `?`.
 *
 * Key rule: `**\/` at any position means "zero or more path segments followed
 * by a separator" — this allows `**\/*.md` to match `README.md` at root
 * (zero segments) as well as `docs/deep/README.md` (two segments).
 * Without this, `**\/*.md` → `^.*\/[^/]*\.md$` which requires at least one
 * `/` and would silently exclude root-level files.
 */
function compileGlob(pattern: string): RegExp {
    let result = '';
    const SPECIAL = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\']);

    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];

        if (ch === '*' && pattern[i + 1] === '*') {
            if (pattern[i + 2] === '/') {
                // **/ → zero or more path segments (optional prefix)
                result += '(.*\\/)?';
                i += 2; // skip **, /
            } else {
                // ** at end of pattern → any characters including /
                result += '.*';
                i += 1; // skip second *
            }
        } else if (ch === '*') {
            // * → any characters within a single path segment
            result += '[^/]*';
        } else if (ch === '?') {
            result += '[^/]';
        } else if (SPECIAL.has(ch)) {
            result += '\\' + ch;
        } else {
            result += ch;
        }
    }

    return new RegExp(`^${result}$`);
}

// =============================================================================
// CONFIG
// =============================================================================

export interface FileFilterConfig {
    /**
     * Glob patterns for files to include.
     * At least one pattern must match for a file to be considered.
     * Example: ['**∕*.md', '**∕*.ts', 'README']
     */
    readonly include: string[];

    /**
     * Glob patterns for files to exclude.
     * Exclusions are evaluated first — they override include matches.
     * Example: ['node_modules/**', '**∕*.test.ts', 'dist/**']
     */
    readonly exclude: string[];

    /**
     * Maximum file size in bytes. Files larger than this are excluded.
     * Prevents embedding pathological files (auto-generated, minified, etc.).
     * Default: 500_000 (500 KB)
     */
    readonly maxSizeBytes?: number;
}

/** Sensible defaults for a TypeScript/documentation repository. */
export const DEFAULT_FILTER_CONFIG: FileFilterConfig = {
    include: [
        // Docs + prose
        '**/*.md',
        '**/*.mdx',
        // JS/TS family
        '**/*.ts',
        '**/*.tsx',
        '**/*.js',
        '**/*.jsx',
        '**/*.mts',
        '**/*.cts',
        // Other source languages (structure-aware via CodeChunker)
        '**/*.py',
        '**/*.go',
        '**/*.rs',
        '**/*.java',
        '**/*.kt',
        '**/*.scala',
        '**/*.cs',
        '**/*.cpp',
        '**/*.cc',
        '**/*.c',
        '**/*.h',
        '**/*.hpp',
        '**/*.swift',
        '**/*.php',
        '**/*.rb',
        // Config + IaC + CI (lane-separated downstream by fileClass)
        '**/*.yaml',
        '**/*.yml',
        '**/*.toml',
        '**/*.tf',
        '**/*.tfvars',
        // Database
        '**/*.sql',
        '**/*.prisma',
        // Scripts + containers (extensionless — matched by exact basename)
        '**/*.sh',
        '**/*.bash',
        '**/Dockerfile',
        '**/*.Dockerfile',
        '**/Makefile',
        // NOTE: *.json is deliberately NOT embedded — config/manifest JSON is
        // structured noise for prose retrieval (tsconfig, package, eslint). The
        // tech-stack signal from manifests is read directly by the ProfileExtractor,
        // not via embedded chunks. Embedding it pollutes skill/experience queries.
    ],
    exclude: [
        // Dependencies (match at any depth — monorepos nest node_modules under packages/)
        '**/node_modules/**',
        '**/.yarn/**',
        '**/vendor/**',

        // Build output
        'dist/**',
        'build/**',
        'out/**',
        '.next/**',
        'cdk.out/**',
        '**/*.d.ts',
        '**/*.js.map',

        // Test artifacts. Test SOURCE is now ingested (lane-separated by
        // fileClass='test' and down-weighted at retrieval) — only coverage
        // reports and mock fixtures are dropped as noise.
        'coverage/**',
        '**/__mocks__/**',

        // Lock files and generated content
        'yarn.lock',
        'package-lock.json',
        'pnpm-lock.yaml',
        '**/*.min.js',
        '**/*.min.css',

        // AI-tooling / planning scaffolding — NOT portfolio evidence.
        // These pollute the KB: the Research Agent retrieves them as if they were
        // demonstrated work, drowning real project code (see ADR / kb-hygiene).
        '**/docs/superpowers/**',
        '**/.agents/**',
        '**/.claude/**',
        '**/.codex/**',
        '**/CLAUDE.md',
        '**/AGENTS.md',
        // .github: keep CI workflows (real delivery evidence), drop the prose
        // noise (issue/PR templates) that would otherwise read as docs.
        '**/.github/ISSUE_TEMPLATE/**',
        '**/.github/PULL_REQUEST_TEMPLATE**',
        '**/.github/**/*.md',
        '**/.github/*.md',
        '**/*.plan.md',
        '**/specs/**',
        '**/plans/**',

        // LLM prompt scaffolding — the system's own personas/constraints, NOT
        // demonstrated portfolio work. These describe how to write content, so
        // they spuriously match resume/skills retrieval queries (e.g.
        // resume-constraints.ts surfaced as candidate "evidence" at cosine 0.398).
        '**/prompts/**',
        '**/*persona*.ts',
        '**/*-constraints.ts',
    ],
    maxSizeBytes: 500_000,
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

export class FileFilter implements IFileFilter {
    private readonly includePatterns: RegExp[];
    private readonly excludePatterns: RegExp[];
    private readonly maxSizeBytes: number;

    constructor(config: FileFilterConfig = DEFAULT_FILTER_CONFIG) {
        this.includePatterns = config.include.map(compileGlob);
        this.excludePatterns = config.exclude.map(compileGlob);
        this.maxSizeBytes    = config.maxSizeBytes ?? 500_000;
    }

    // =========================================================================
    // IFileFilter
    // =========================================================================

    shouldInclude(filePath: string): boolean {
        // Exclude takes priority
        if (this.excludePatterns.some(re => re.test(filePath))) return false;
        // Must match at least one include pattern
        return this.includePatterns.some(re => re.test(filePath));
    }

    filter(filePaths: string[]): string[] {
        return filePaths.filter(p => this.shouldInclude(p));
    }

    /**
     * Filter extended with size information.
     * Use this when the repo adapter provides file metadata.
     */
    filterWithSize(files: Array<{ path: string; sizeBytes: number }>): string[] {
        return files
            .filter(f => f.sizeBytes <= this.maxSizeBytes && this.shouldInclude(f.path))
            .map(f => f.path);
    }
}
