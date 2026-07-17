/** @format */
import { describe, it, expect, jest } from '@jest/globals';
import type { Pool } from 'pg';
import { extractRoleSignals, loadRepoRoleSignals } from '../repo-role-signals.js';
import { classifyComponentKind } from '../component-kind.js';

describe('extractRoleSignals', () => {
    it('projects archetype/evidence/fileClass JSON into signals (kb → infra)', () => {
        const s = extractRoleSignals({
            repository_id: 'kb', primary_language: 'TypeScript', topics: [], tech_stack: [],
            archetype_signals: { has_iac: 'true', has_k8s_manifests: true, has_helm_chart: 'true', has_argocd_apps: true },
            evidence_topology: { is_monorepo: false, migration_tools: [] },
            file_class_counts: { source: 1, iac: 4, ci: 57 },
        });
        expect(s.archetype.has_helm_chart).toBe(true);
        expect(s.fileClassCounts.source).toBe(1);
        expect(classifyComponentKind(s)).toBe('infra'); // end-to-end through the classifier
    });

    it('tolerates null archetype/evidence/fileClass (unsynced repo)', () => {
        const s = extractRoleSignals({
            repository_id: 'x', primary_language: null, topics: null, tech_stack: null,
            archetype_signals: null, evidence_topology: null, file_class_counts: null,
        });
        expect(s.archetype.has_iac).toBe(false);
        expect(s.fileClassCounts.source).toBe(0);
        expect(s.techStack).toEqual([]);
        expect(classifyComponentKind(s)).toBe('shared');
    });
});

describe('loadRepoRoleSignals', () => {
    it('keys the signals map by repository id', async () => {
        const query = jest.fn(async () => ({ rows: [
            { repository_id: 'kb', primary_language: 'TypeScript', topics: [], tech_stack: [],
              archetype_signals: { has_helm_chart: true }, evidence_topology: {}, file_class_counts: { source: 1 } },
        ] }));
        const pool = { query } as unknown as Pool;
        const map = await loadRepoRoleSignals(pool, 'user-1');
        expect(map.has('kb')).toBe(true);
        expect(map.get('kb')!.archetype.has_helm_chart).toBe(true);
        expect((query.mock.calls[0] as unknown[])[1]).toEqual(['user-1']);
    });
});
