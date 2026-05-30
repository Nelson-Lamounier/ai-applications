/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { TechnologyOntologyRepository } from './TechnologyOntologyRepository.js';

function fakePool(rows: unknown[] = []) {
    const calls: { sql: string; params?: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            return { rows };
        }),
    };
}

describe('TechnologyOntologyRepository.loadAliasMap', () => {
    it('builds a Map from alias rows', async () => {
        const pool = fakePool([
            { alias: 'k8s', technology_id: 'id-kube' },
            { alias: 'react', technology_id: 'id-react' },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const map = await repo.loadAliasMap();
        expect(map.get('k8s')).toBe('id-kube');
        expect(map.get('react')).toBe('id-react');
        expect(pool.calls[0].sql).toContain('FROM technology_aliases');
    });
});

describe('TechnologyOntologyRepository.loadProseSafeAliases', () => {
    it('returns a lowercase Set of prose-safe aliases', async () => {
        const pool = fakePool([
            { alias: 'Kubernetes' },
            { alias: 'GRAFANA' },
            { alias: 'pgvector' },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const set = await repo.loadProseSafeAliases();
        expect(set.size).toBe(3);
        expect(set.has('kubernetes')).toBe(true);
        expect(set.has('grafana')).toBe(true);
        expect(set.has('pgvector')).toBe(true);
        // Original casing is normalised out
        expect(set.has('Kubernetes')).toBe(false);
        // Query filters on prose_safe = true
        expect(pool.calls[0].sql).toContain('WHERE prose_safe = true');
    });

    it('returns an empty set when no rows are prose-safe yet', async () => {
        const pool = fakePool([]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const set = await repo.loadProseSafeAliases();
        expect(set.size).toBe(0);
    });
});

describe('TechnologyOntologyRepository.currentVersion', () => {
    it('returns the single-row version', async () => {
        const pool = fakePool([{ version: 7 }]);
        const repo = new TechnologyOntologyRepository(pool as never);
        expect(await repo.currentVersion()).toBe(7);
        expect(pool.calls[0].sql).toContain('FROM ontology_version');
    });
});
