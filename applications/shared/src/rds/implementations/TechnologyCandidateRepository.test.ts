/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import { TechnologyCandidateRepository } from './TechnologyCandidateRepository.js';

function fakePool() {
    const calls: { sql: string; params?: unknown[] }[] = [];
    return {
        calls,
        query: jest.fn(async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return { rows: [] }; }),
    };
}

describe('TechnologyCandidateRepository.upsert', () => {
    it('upserts with occurrence increment on conflict', async () => {
        const pool = fakePool();
        const repo = new TechnologyCandidateRepository(pool as never);
        await repo.upsert({
            rawName: 'K8s-Operator', normalizedName: 'k8soperator', ecosystem: 'iac',
            userId: 'u1', repoFullName: 'o/r', filePath: 'main.tf',
        });
        const c = pool.calls[0];
        expect(c.sql).toContain('INSERT INTO technology_candidates');
        expect(c.sql).toContain('ON CONFLICT (normalized_name, ecosystem)');
        expect(c.sql).toContain('occurrence_count = technology_candidates.occurrence_count + 1');
        expect(c.params).toContain('k8soperator');
    });

    it("defaults ecosystem to 'unknown' when not provided", async () => {
        const pool = fakePool();
        const repo = new TechnologyCandidateRepository(pool as never);
        await repo.upsert({
            rawName: 'mystery', normalizedName: 'mystery',
            userId: 'u1', repoFullName: 'o/r', filePath: 'README.md',
        });
        expect(pool.calls[0].params).toContain('unknown');
    });
});
