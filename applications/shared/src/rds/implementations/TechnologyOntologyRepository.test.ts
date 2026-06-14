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

describe('TechnologyOntologyRepository.loadCategoryGroups', () => {
    it('groups by category and drops singletons', async () => {
        const pool = fakePool([
            { canonical_name: 'anthropic_claude', category: 'ai_platform' },
            { canonical_name: 'openai',            category: 'ai_platform' },
            { canonical_name: 'aws_vpc',           category: 'cloud_networking' },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const groups = await repo.loadCategoryGroups();
        // Only the ai_platform group has ≥2 members; cloud_networking singleton is dropped
        expect(groups).toHaveLength(1);
        expect(new Set(groups[0])).toEqual(new Set(['anthropic_claude', 'openai']));
        expect(pool.calls[0].sql).toContain('FROM technology_ontology');
        expect(pool.calls[0].sql).toContain('is_active = true');
        expect(pool.calls[0].sql).toContain("curation_level IN ('curated', 'auto_imported')");
    });

    it('returns empty array when all categories are singletons', async () => {
        const pool = fakePool([
            { canonical_name: 'anthropic_claude', category: 'ai_platform' },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        expect(await repo.loadCategoryGroups()).toEqual([]);
    });

    it('lowercases canonical names', async () => {
        const pool = fakePool([
            { canonical_name: 'TypeScript', category: 'language' },
            { canonical_name: 'JavaScript', category: 'language' },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const groups = await repo.loadCategoryGroups();
        expect(new Set(groups[0])).toEqual(new Set(['typescript', 'javascript']));
    });
});

describe('TechnologyOntologyRepository.loadTransferGroups', () => {
    it('returns [] when relationships table is empty', async () => {
        const pool = fakePool([]);
        const repo = new TechnologyOntologyRepository(pool as never);
        expect(await repo.loadTransferGroups()).toEqual([]);
        expect(pool.calls[0].sql).toContain('FROM technology_relationships');
    });

    it('merges a triangle of edges into one component', async () => {
        // claude↔openai, bedrock↔openai, claude↔bedrock — should all merge
        const pool = fakePool([
            { from_name: 'anthropic_claude', to_name: 'openai' },
            { from_name: 'aws_bedrock',      to_name: 'openai' },
            { from_name: 'anthropic_claude', to_name: 'aws_bedrock' },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const groups = await repo.loadTransferGroups();
        expect(groups).toHaveLength(1);
        expect(new Set(groups[0])).toEqual(
            new Set(['anthropic_claude', 'openai', 'aws_bedrock']),
        );
    });

    it('keeps disconnected components separate', async () => {
        const pool = fakePool([
            { from_name: 'anthropic_claude', to_name: 'openai' },
            { from_name: 'typescript',       to_name: 'javascript' },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const groups = await repo.loadTransferGroups();
        expect(groups).toHaveLength(2);
        const sets = groups.map(g => new Set(g));
        const claudeGroup = sets.find(s => s.has('anthropic_claude'));
        const tsGroup = sets.find(s => s.has('typescript'));
        expect(claudeGroup).toEqual(new Set(['anthropic_claude', 'openai']));
        expect(tsGroup).toEqual(new Set(['typescript', 'javascript']));
    });

    it('lowercases canonical names', async () => {
        const pool = fakePool([
            { from_name: 'Anthropic_Claude', to_name: 'OpenAI' },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const groups = await repo.loadTransferGroups();
        expect(new Set(groups[0])).toEqual(new Set(['anthropic_claude', 'openai']));
    });
});

describe('TechnologyOntologyRepository.loadRepoCodeTech', () => {
    it('aggregates code tech across ALL commits — no single latest_commit shadowing', async () => {
        const pool = fakePool([
            { repo_full_name: 'o/r', canonical: 'aws_eks' },
            { repo_full_name: 'o/r', canonical: 'kubernetes' },
            { repo_full_name: 'o/r2', canonical: 'python' },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const map = await repo.loadRepoCodeTech('u1');
        expect([...map.get('o/r')!].sort()).toEqual(['aws_eks', 'kubernetes']);
        expect([...map.get('o/r2')!]).toEqual(['python']);
        // The fix: no single-latest-commit filter that a partial/'HEAD' run could shadow.
        expect(pool.calls[0].sql).not.toContain('latest_commit');
        expect(pool.calls[0].sql).toContain("source_layer IN ('syft', 'treesitter', 'iac', 'dockerfile')");
    });
});

describe('TechnologyOntologyRepository.loadCanonicalToCodeFiles', () => {
    it('maps canonical → code files aggregated across commits (no latest_commit)', async () => {
        const pool = fakePool([
            { canonical: 'aws_eks', path: 'o/r/infra/eks.ts' },
            { canonical: 'aws_eks', path: 'o/r/infra/eks-addons.ts' },
            { canonical: 'python', path: 'o/r/scripts/x.py' },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const map = await repo.loadCanonicalToCodeFiles('u1');
        expect(map.get('aws_eks')).toEqual(['o/r/infra/eks.ts', 'o/r/infra/eks-addons.ts']);
        expect(map.get('python')).toEqual(['o/r/scripts/x.py']);
        expect(pool.calls[0].sql).not.toContain('latest_commit');
    });

    it('also maps files to their LANGUAGE by extension (a .py file proves python)', async () => {
        const pool = fakePool([]);
        const repo = new TechnologyOntologyRepository(pool as never);
        await repo.loadCanonicalToCodeFiles('u1');
        const sql = pool.calls[0].sql;
        // The extension→language UNION must be present so a Checkov rule .py file tagged
        // 'checkov' still counts toward 'python' (the cdk-monitoring coverage gap).
        expect(sql).toMatch(/ILIKE '%\.py'\s*THEN 'python'/);
        expect(sql).toMatch(/ILIKE '%\.tsx'\s*THEN 'typescript'/);
        expect(sql).toMatch(/UNION/);
    });
});
