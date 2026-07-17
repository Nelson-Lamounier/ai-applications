/**
 * @format
 * run-ingestion — UNIFIED_INGESTION=shadow path.
 *
 * Covers the two shadow-gate fixes from the P1 final review:
 *   1. `loadPersistedEvidenceKeys` must scope the legacy (persisted,
 *      two-job path) read to the shadow run's resolved commit sha --
 *      without it, the query is the historical union of every prior sync
 *      and stale rows for since-removed files depress the parity gate.
 *   2. `runUnifiedShadow` must warn distinctly (`unified_shadow.legacy_empty`)
 *      when the legacy side is empty for that sha (the sibling tech-extract
 *      Job likely hasn't finished yet) while still recording the parity
 *      rows -- the shadow gate must not go silent just because the two
 *      concurrently-dispatched jobs raced.
 *
 * `run-ingestion.ts` is a K8s Job entrypoint (`main()` only auto-runs behind
 * `require.main === module`, mirroring job-strategist's `run-pipeline.ts`),
 * so importing it here is side-effect-free. `bootstrapK8sObservability` is a
 * process-wide singleton (cached on `globalThis.__obsHandle`): calling it
 * once here, BEFORE requiring `run-ingestion.js`, and spying on the
 * returned `logger` gives access to the exact same instance
 * `run-ingestion.ts`'s module-scope `const log = obs.logger` resolves to,
 * with no need to mock `@bedrock/shared` itself (which would risk a second
 * `prom-client` registry instance for the module-scope `Counter`s).
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { bootstrapK8sObservability } from '@bedrock/shared';
import type * as RunIngestionModule from './run-ingestion.js';

const obs = bootstrapK8sObservability({ serviceName: 'run-ingestion-unified-shadow-test' });
const warnSpy = jest.spyOn(obs.logger, 'warn').mockImplementation(() => obs.logger);

const runFactsStageMock: jest.Mock<() => Promise<unknown>> = jest.fn();
jest.mock('./facts/run-facts-stage.js', () => ({
    runFactsStage: runFactsStageMock,
}));

jest.mock('./acquisition/tarball/fetchTarball.js', () => ({
    fetchTarball: jest.fn(async () => 'resolved-sha-123'),
}));

jest.mock('./acquisition/tarball/safeExtract.js', () => ({
    safeExtract: jest.fn(async () => {}),
}));

const insertManyMock = jest.fn(async () => {});
jest.mock('./persistence/UnifiedParityRunRepository.js', () => ({
    UnifiedParityRunRepository: jest.fn().mockImplementation(() => ({
        insertMany: insertManyMock,
    })),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadPersistedEvidenceKeys, runUnifiedShadow } = require('./run-ingestion.js') as typeof RunIngestionModule;

/** Recording fake `pg.Pool`: captures every `query(sql, params)` call. */
function fakePool(rows: unknown[] = []) {
    const calls: { sql: string; params: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params: unknown[] = []) => {
            calls.push({ sql, params });
            return { rows };
        }),
    };
}

describe('loadPersistedEvidenceKeys', () => {
    beforeEach(() => {
        warnSpy.mockClear();
    });

    it("scopes the SELECT to the shadow run's resolved commit sha", async () => {
        const pool = fakePool([]);

        await loadPersistedEvidenceKeys(pool as never, 'user-1', 'org/repo', 'sha-abc123');

        expect(pool.calls).toHaveLength(1);
        const [{ sql, params }] = pool.calls;
        expect(sql).toMatch(/te\.commit_sha\s*=\s*\$3/);
        expect(params).toEqual(['user-1', 'org/repo', 'sha-abc123']);
    });

    it('maps rows into EvidenceKey shape with lower-cased canonicalId', async () => {
        const pool = fakePool([
            { canonical_name: 'Node.JS', source_layer: 'manifest', file_path: 'package.json' },
        ]);

        const keys = await loadPersistedEvidenceKeys(pool as never, 'user-1', 'org/repo', 'sha-abc123');

        expect(keys).toEqual([
            { sourceLayer: 'manifest', canonicalId: 'node.js', filePath: 'package.json' },
        ]);
    });
});

describe('runUnifiedShadow', () => {
    beforeEach(() => {
        warnSpy.mockClear();
        insertManyMock.mockClear();
        runFactsStageMock.mockReset();
        runFactsStageMock.mockResolvedValue({
            evidenceKeys:     [{ sourceLayer: 'manifest', canonicalId: 'express', filePath: 'package.json' }],
            failedExtractors: [],
            durationMs:       10,
        });
    });

    it('warns unified_shadow.legacy_empty and still records parity when the legacy side is empty', async () => {
        // Legacy loader (pool.query) returns zero rows for this sha -- the
        // sibling tech-extract Job likely hasn't finished for this commit yet.
        const pool = fakePool([]);

        await runUnifiedShadow(pool as never, {
            userId:       'user-1',
            repoFullName: 'org/repo',
            githubRepoId: 42,
            githubToken:  'gh-token',
            commitSha:    'sha-abc123',
        });

        expect(warnSpy).toHaveBeenCalledWith(
            expect.objectContaining({ repoFullName: 'org/repo' }),
            expect.stringContaining('unified_shadow.legacy_empty'),
        );
        // Parity rows are still recorded (the unified side has one evidence
        // key, so computeLayerParity produces a non-empty row set).
        expect(insertManyMock).toHaveBeenCalledTimes(1);
        const call = insertManyMock.mock.calls[0] as unknown as [string, string, string, unknown[]];
        const rows = call[3];
        expect(rows.length).toBeGreaterThan(0);
    });

    it('does not warn legacy_empty when the legacy side has rows for this sha', async () => {
        const pool = fakePool([
            { canonical_name: 'Express', source_layer: 'manifest', file_path: 'package.json' },
        ]);

        await runUnifiedShadow(pool as never, {
            userId:       'user-1',
            repoFullName: 'org/repo',
            githubRepoId: 42,
            githubToken:  'gh-token',
            commitSha:    'sha-abc123',
        });

        const legacyEmptyWarnings = warnSpy.mock.calls.filter(
            (call) => typeof call[1] === 'string' && call[1].includes('unified_shadow.legacy_empty'),
        );
        expect(legacyEmptyWarnings).toHaveLength(0);
        expect(insertManyMock).toHaveBeenCalledTimes(1);
    });
});
