/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { SkillOntologyWriteRepository } from './SkillOntologyWriteRepository.js';
import type { Pool } from 'pg';

/** Minimal pg stub: route by SQL fragment, record write calls. */
function fakePool(handlers: Array<[RegExp, (params: unknown[]) => { rows?: unknown[]; rowCount?: number }]>) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
        query: jest.fn(async (sql: string, params: unknown[] = []) => {
            calls.push({ sql, params });
            for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
            return { rows: [], rowCount: 0 };
        }),
    } as unknown as Pool;
    return { pool, calls };
}

describe('SkillOntologyWriteRepository.insertAutoImported', () => {
    it('inserts a new auto canonical with provenance', async () => {
        const { pool, calls } = fakePool([
            [/SELECT id, curation_level/, () => ({ rows: [] })],
            [/INSERT INTO skill_ontology/, () => ({ rows: [{ id: 'new-1' }] })],
        ]);
        const r = await new SkillOntologyWriteRepository(pool).insertAutoImported(
            'kubernetes networking', 'Kubernetes Networking', 'infrastructure', 'onet', 'CC-BY-4.0', 'http://x');
        expect(r).toEqual({ id: 'new-1', curatedSkip: false });
        expect(calls.some((c) => /INSERT INTO skill_ontology/.test(c.sql))).toBe(true);
    });

    it('NEVER overwrites a curated row (FR-008) — returns existing id, no insert/update', async () => {
        const { pool, calls } = fakePool([
            [/SELECT id, curation_level/, () => ({ rows: [{ id: 'cur-1', curation_level: 'curated' }] })],
        ]);
        const r = await new SkillOntologyWriteRepository(pool).insertAutoImported(
            'rest api design', 'REST API Design', 'api', 'onet', 'CC-BY-4.0', null);
        expect(r).toEqual({ id: 'cur-1', curatedSkip: true });
        expect(calls.some((c) => /INSERT INTO skill_ontology|UPDATE skill_ontology/.test(c.sql))).toBe(false);
    });

    it('idempotent for an existing auto row — refreshes provenance, no duplicate insert', async () => {
        const { pool, calls } = fakePool([
            [/SELECT id, curation_level/, () => ({ rows: [{ id: 'auto-1', curation_level: 'auto_imported' }] })],
            [/UPDATE skill_ontology/, () => ({ rowCount: 1 })],
        ]);
        const r = await new SkillOntologyWriteRepository(pool).insertAutoImported(
            'observability', 'Observability', 'observability', 'onet', 'CC-BY-4.0', null);
        expect(r).toEqual({ id: 'auto-1', curatedSkip: false });
        expect(calls.some((c) => /INSERT INTO skill_ontology/.test(c.sql))).toBe(false);
        expect(calls.some((c) => /UPDATE skill_ontology/.test(c.sql))).toBe(true);
    });
});
