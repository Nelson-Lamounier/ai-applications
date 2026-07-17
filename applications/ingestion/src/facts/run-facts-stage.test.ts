/**
 * @format
 * run-facts-stage — persist vs shadow mode.
 *
 * Fixture is a real temp directory with a single Dockerfile (fs.mkdtemp),
 * exercising the real deterministic extractors (iac/Dockerfile, TreeSitter)
 * end to end. SyftExtractor has no `syft` binary in the test environment, so
 * it fails closed via `Promise.allSettled` — proving the documented
 * fail-open contract (a missing SYFT_BIN is a failed lane, never a crash).
 *
 * `pool` is a recording fake: every statement (both plain `pool.query` and
 * `client.query` inside a `BEGIN`/`COMMIT` transaction) is routed by SQL
 * substring and logged to `calls`, so tests can assert exactly which writes
 * did/did not happen without a live Postgres.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runFactsStage } from './run-facts-stage.js';

interface Route { readonly needle: string; readonly rows: unknown[] }

/** Recording fake Pool: routes by SQL substring (first match wins), else `rows: []`. */
function fakePool(routes: Route[] = []) {
    const calls: string[] = [];
    const respond = (sql: string) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        calls.push(normalized);
        const hit = routes.find((r) => normalized.includes(r.needle));
        return { rows: hit ? hit.rows : [] };
    };
    const client = { query: jest.fn(async (sql: string) => respond(sql)), release: jest.fn() };
    const pool = {
        query: jest.fn(async (sql: string) => respond(sql)),
        connect: jest.fn(async () => client),
    };
    return { pool, calls };
}

const ONTOLOGY_ROUTES: Route[] = [
    { needle: 'FROM ontology_version', rows: [{ version: 5 }] },
    { needle: 'alias, technology_id FROM technology_aliases', rows: [{ alias: 'node', technology_id: 'id-node' }] },
    { needle: 'WHERE prose_safe = true', rows: [] },
    { needle: 'SELECT id, canonical_name FROM technology_ontology', rows: [{ id: 'id-node', canonical_name: 'Node.js' }] },
];

describe('runFactsStage', () => {
    let extractDir: string;

    beforeEach(async () => {
        extractDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-facts-stage-'));
        await fs.writeFile(path.join(extractDir, 'Dockerfile'), 'FROM node:22-alpine\n');
    });

    afterEach(async () => {
        await fs.rm(extractDir, { recursive: true, force: true });
    });

    it('persist: writes evidence/markers and returns evidenceKeys resolved to lowercased canonical names', async () => {
        const { pool, calls } = fakePool(ONTOLOGY_ROUTES);

        const result = await runFactsStage({
            pool: pool as never, userId: 'u1', repoFullName: 'o/r', githubRepoId: 999,
            commitSha: 'abc', extractDir, writeMode: 'persist',
            laneGates: { techDone: false, dsaDone: false, aiDone: false },
            githubSbomEnabled: false, githubToken: 'tok',
        });

        // Dockerfile's `FROM node:...` resolves via the alias map to id-node,
        // which loadIdToCanonicalMap maps to the lowercased canonical name.
        expect(result.evidenceKeys).toContainEqual({ sourceLayer: 'dockerfile', canonicalId: 'node.js', filePath: 'Dockerfile' });
        // SYFT_BIN is unset in the test environment -- syft fails closed, never crashes the stage.
        expect(result.failedExtractors).toContain('syft');
        expect(typeof result.durationMs).toBe('number');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);

        // Persist mode writes technology_evidence + both scan markers (even with 0 DSA/AI matches).
        expect(calls.some((c) => c.includes('INSERT INTO technology_evidence'))).toBe(true);
        expect(calls.some((c) => c.includes('INSERT INTO dsa_scanned_commits'))).toBe(true);
        expect(calls.some((c) => c.includes('INSERT INTO ai_scanned_commits'))).toBe(true);
    });

    it('shadow: resolves the same evidenceKeys but performs NO writes of any kind', async () => {
        const { pool, calls } = fakePool(ONTOLOGY_ROUTES);

        const result = await runFactsStage({
            pool: pool as never, userId: 'u1', repoFullName: 'o/r', githubRepoId: 999,
            commitSha: 'abc', extractDir, writeMode: 'shadow',
            githubSbomEnabled: false, githubToken: 'tok',
        });

        expect(result.evidenceKeys).toContainEqual({ sourceLayer: 'dockerfile', canonicalId: 'node.js', filePath: 'Dockerfile' });
        expect(result.failedExtractors).toContain('syft');

        const writes = calls.filter((c) => c.startsWith('INSERT') || c.startsWith('UPDATE') || c.startsWith('DELETE'));
        expect(writes).toEqual([]);
    });

    it('shadow ignores the caller-supplied idempotency gates -- always recomputes fresh rows', async () => {
        const { pool } = fakePool(ONTOLOGY_ROUTES);

        const result = await runFactsStage({
            pool: pool as never, userId: 'u1', repoFullName: 'o/r', githubRepoId: 999,
            commitSha: 'abc', extractDir, writeMode: 'shadow',
            // Would short-circuit every lane in persist mode.
            laneGates: { techDone: true, dsaDone: true, aiDone: true },
            githubSbomEnabled: false, githubToken: 'tok',
        });

        expect(result.evidenceKeys).toContainEqual({ sourceLayer: 'dockerfile', canonicalId: 'node.js', filePath: 'Dockerfile' });
    });

    it('persist: caller-supplied techDone gate skips the tech lane -- no evidenceKeys, no tech-lane reads', async () => {
        const { pool, calls } = fakePool(ONTOLOGY_ROUTES);

        const result = await runFactsStage({
            pool: pool as never, userId: 'u1', repoFullName: 'o/r', githubRepoId: 999,
            commitSha: 'abc', extractDir, writeMode: 'persist',
            laneGates: { techDone: true, dsaDone: false, aiDone: false },
            githubSbomEnabled: false, githubToken: 'tok',
        });

        expect(result.evidenceKeys).toEqual([]);
        expect(calls.some((c) => c.includes('FROM ontology_version'))).toBe(false);
        expect(calls.some((c) => c.includes('INSERT INTO technology_evidence'))).toBe(false);
    });

    it('persist HEAD-mode regression: gates from the UNSET env sha (all-false) mean a second run of an already-scanned resolved sha still executes the lanes', async () => {
        // The pre-refactor entrypoint computed its gates from env.commitSha (raw,
        // undefined in HEAD mode -> all false) BEFORE the tarball resolved a real
        // sha, so an unchanged repo's second HEAD-mode run always re-ran the lanes.
        // runFactsStage must NOT recompute gates from the resolved sha: even with
        // the DB reporting evidence for 'abc', omitted laneGates (the all-false
        // default) must still execute and write.
        const routes = [
            ...ONTOLOGY_ROUTES,
            // DB state after run 1: evidence + both scan markers exist for 'abc'.
            // A gate recomputation from the resolved sha would hit these and skip.
            { needle: 'FROM technology_evidence WHERE user_id', rows: [{ '?column?': 1 }] },
            { needle: 'FROM dsa_scanned_commits', rows: [{ '?column?': 1 }] },
            { needle: 'FROM ai_scanned_commits', rows: [{ '?column?': 1 }] },
        ];

        for (let run = 1; run <= 2; run++) {
            const { pool, calls } = fakePool(routes);
            const result = await runFactsStage({
                pool: pool as never, userId: 'u1', repoFullName: 'o/r', githubRepoId: 999,
                commitSha: 'abc', extractDir, writeMode: 'persist',
                // laneGates omitted: HEAD-mode callers computed all-false from the
                // unset env sha; the default must behave identically.
                githubSbomEnabled: false, githubToken: 'tok',
            });

            expect(result.evidenceKeys).toContainEqual({ sourceLayer: 'dockerfile', canonicalId: 'node.js', filePath: 'Dockerfile' });
            expect(calls.some((c) => c.includes('INSERT INTO technology_evidence'))).toBe(true);
            // And no internal gate reads happened at all.
            expect(calls.some((c) => c.includes('FROM technology_evidence WHERE user_id'))).toBe(false);
            expect(calls.some((c) => c.includes('FROM dsa_scanned_commits'))).toBe(false);
            expect(calls.some((c) => c.includes('FROM ai_scanned_commits'))).toBe(false);
        }
    });
});
