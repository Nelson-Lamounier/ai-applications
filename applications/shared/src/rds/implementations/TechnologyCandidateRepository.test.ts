/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import type { Pool } from 'pg';
import { isNoiseCandidate, TechnologyCandidateRepository } from './TechnologyCandidateRepository.js';

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

describe('isNoiseCandidate', () => {
    it('drops GitHub Actions workflow steps by ecosystem', () => {
        expect(isNoiseCandidate('actions/checkout', 'github-action')).toBe(true);
        expect(isNoiseCandidate('actions/checkout', 'github_actions')).toBe(true);
    });
    it('drops local action paths, node builtins, and typings', () => {
        expect(isNoiseCandidate('./.github/actions/configure-aws', 'unknown')).toBe(true);
        expect(isNoiseCandidate('node:child_process', 'typescript')).toBe(true);
        expect(isNoiseCandidate('@types/node', 'npm')).toBe(true);
    });
    it('keeps real package names', () => {
        expect(isNoiseCandidate('pinecone-client', 'npm')).toBe(false);
        expect(isNoiseCandidate('@nestjs/core', 'npm')).toBe(false);
    });
});

describe('upsert noise filtering', () => {
    it('never inserts a noise candidate', async () => {
        const query = jest.fn<() => Promise<{ rows: unknown[] }>>().mockResolvedValue({ rows: [] });
        const repo = new TechnologyCandidateRepository({ query } as unknown as Pool);
        await repo.upsert({ rawName: 'actions/checkout', normalizedName: 'actionscheckout', ecosystem: 'github-action', userId: 'u', repoFullName: 'o/r', filePath: 'f' });
        expect(query).not.toHaveBeenCalled();
    });
});
