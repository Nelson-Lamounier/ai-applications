/**
 * @format
 * FileFilter Unit Tests
 *
 * Pure logic — no mocks, no async, no AWS calls.
 */

import { FileFilter, DEFAULT_FILTER_CONFIG } from './FileFilter';

describe('FileFilter', () => {
    // =========================================================================
    // shouldInclude — basic include matching
    // =========================================================================
    describe('shouldInclude — include patterns', () => {
        const filter = new FileFilter({
            include: ['**/*.md', '**/*.ts', 'README'],
            exclude: [],
        });

        it('matches **/*.md at any depth', () => {
            expect(filter.shouldInclude('README.md')).toBe(true);
            expect(filter.shouldInclude('docs/overview.md')).toBe(true);
            expect(filter.shouldInclude('docs/architecture/adr-001.md')).toBe(true);
        });

        it('matches **/*.ts at any depth', () => {
            expect(filter.shouldInclude('src/index.ts')).toBe(true);
            expect(filter.shouldInclude('src/rds/types.ts')).toBe(true);
        });

        it('matches exact filename at root', () => {
            expect(filter.shouldInclude('README')).toBe(true);
        });

        it('rejects non-matching extensions', () => {
            expect(filter.shouldInclude('main.py')).toBe(false);
            expect(filter.shouldInclude('styles.css')).toBe(false);
            expect(filter.shouldInclude('binary.bin')).toBe(false);
        });

        it('rejects file with no extension that does not match exactly', () => {
            expect(filter.shouldInclude('Makefile')).toBe(false);
            expect(filter.shouldInclude('LICENSE')).toBe(false);
        });
    });

    // =========================================================================
    // shouldInclude — exclude takes priority
    // =========================================================================
    describe('shouldInclude — exclude priority', () => {
        const filter = new FileFilter({
            include: ['**/*.ts'],
            exclude: ['**/*.test.ts', '**/__tests__/**', 'dist/**'],
        });

        it('excludes test files even when they match include pattern', () => {
            expect(filter.shouldInclude('src/utils.test.ts')).toBe(false);
            expect(filter.shouldInclude('src/agent-runner.test.ts')).toBe(false);
        });

        it('excludes files under __tests__ directory', () => {
            expect(filter.shouldInclude('src/__tests__/utils.ts')).toBe(false);
        });

        it('excludes dist output', () => {
            expect(filter.shouldInclude('dist/index.js')).toBe(false);
            expect(filter.shouldInclude('dist/src/types.ts')).toBe(false);
        });

        it('includes non-excluded .ts files', () => {
            expect(filter.shouldInclude('src/index.ts')).toBe(true);
            expect(filter.shouldInclude('src/rds/types.ts')).toBe(true);
        });
    });

    // =========================================================================
    // shouldInclude — node_modules
    // =========================================================================
    describe('shouldInclude — node_modules exclusion', () => {
        const filter = new FileFilter(DEFAULT_FILTER_CONFIG);

        it('excludes node_modules at root', () => {
            expect(filter.shouldInclude('node_modules/lodash/index.js')).toBe(false);
        });

        it('excludes nested node_modules', () => {
            expect(filter.shouldInclude('packages/shared/node_modules/zod/lib/index.ts')).toBe(false);
        });

        it('still includes source .ts files', () => {
            expect(filter.shouldInclude('src/index.ts')).toBe(true);
        });
    });

    // =========================================================================
    // shouldInclude — glob edge cases
    // =========================================================================
    describe('shouldInclude — glob patterns', () => {
        it('* does not cross path separators', () => {
            const filter = new FileFilter({ include: ['*.md'], exclude: [] });
            expect(filter.shouldInclude('README.md')).toBe(true);
            expect(filter.shouldInclude('docs/README.md')).toBe(false);
        });

        it('** crosses path separators', () => {
            const filter = new FileFilter({ include: ['**/*.md'], exclude: [] });
            expect(filter.shouldInclude('README.md')).toBe(true);
            expect(filter.shouldInclude('docs/README.md')).toBe(true);
            expect(filter.shouldInclude('a/b/c/deep.md')).toBe(true);
        });

        it('directory prefix with **', () => {
            const filter = new FileFilter({ include: ['src/**'], exclude: [] });
            expect(filter.shouldInclude('src/index.ts')).toBe(true);
            expect(filter.shouldInclude('src/rds/types.ts')).toBe(true);
            expect(filter.shouldInclude('test/utils.ts')).toBe(false);
        });
    });

    // =========================================================================
    // filter() — array variant
    // =========================================================================
    describe('filter()', () => {
        const filter = new FileFilter({
            include: ['**/*.md', '**/*.ts'],
            exclude: ['**/*.test.ts', 'node_modules/**'],
        });

        it('returns only included paths', () => {
            const paths = [
                'README.md',
                'src/index.ts',
                'src/index.test.ts',
                'node_modules/zod/src/types.ts',
                'styles.css',
            ];

            expect(filter.filter(paths)).toEqual(['README.md', 'src/index.ts']);
        });

        it('returns empty array when nothing matches', () => {
            expect(filter.filter(['image.png', 'data.csv'])).toEqual([]);
        });

        it('handles empty input', () => {
            expect(filter.filter([])).toEqual([]);
        });
    });

    // =========================================================================
    // filterWithSize()
    // =========================================================================
    describe('filterWithSize()', () => {
        const filter = new FileFilter({
            include: ['**/*.md'],
            exclude: [],
            maxSizeBytes: 100_000,
        });

        it('excludes files exceeding maxSizeBytes', () => {
            const files = [
                { path: 'small.md', sizeBytes: 50_000 },
                { path: 'large.md', sizeBytes: 200_000 },
            ];

            expect(filter.filterWithSize(files)).toEqual(['small.md']);
        });

        it('includes files exactly at the limit', () => {
            const files = [{ path: 'exact.md', sizeBytes: 100_000 }];
            expect(filter.filterWithSize(files)).toEqual(['exact.md']);
        });
    });

    // =========================================================================
    // DEFAULT_FILTER_CONFIG smoke test
    // =========================================================================
    describe('DEFAULT_FILTER_CONFIG', () => {
        const filter = new FileFilter(DEFAULT_FILTER_CONFIG);

        it('includes common source and doc file types', () => {
            expect(filter.shouldInclude('README.md')).toBe(true);
            expect(filter.shouldInclude('src/index.ts')).toBe(true);
            expect(filter.shouldInclude('src/component.tsx')).toBe(true);
            expect(filter.shouldInclude('config.yaml')).toBe(true);
            expect(filter.shouldInclude('package.json')).toBe(true);
        });

        it('excludes build and test artifacts', () => {
            expect(filter.shouldInclude('dist/index.js')).toBe(false);
            expect(filter.shouldInclude('.next/server/app.js')).toBe(false);
            expect(filter.shouldInclude('src/foo.test.ts')).toBe(false);
            expect(filter.shouldInclude('yarn.lock')).toBe(false);
            expect(filter.shouldInclude('coverage/lcov.info')).toBe(false);
        });

        it('excludes type declaration files', () => {
            expect(filter.shouldInclude('src/index.d.ts')).toBe(false);
        });
    });
});
