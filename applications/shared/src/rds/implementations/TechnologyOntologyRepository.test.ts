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

describe('TechnologyOntologyRepository.loadIdToCanonicalMap', () => {
    it('builds a Map from technology_id -> lowercased canonical_name', async () => {
        const pool = fakePool([
            { id: 'id-kube', canonical_name: 'Kubernetes' },
            { id: 'id-react', canonical_name: 'React' },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const map = await repo.loadIdToCanonicalMap();
        expect(map.get('id-kube')).toBe('kubernetes');
        expect(map.get('id-react')).toBe('react');
        expect(pool.calls[0].sql).toContain('FROM technology_ontology');
    });

    it('returns an empty map when the ontology is empty', async () => {
        const pool = fakePool([]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const map = await repo.loadIdToCanonicalMap();
        expect(map.size).toBe(0);
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
        expect(new Set(groups[0].members)).toEqual(new Set(['anthropic_claude', 'openai']));
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
        expect(new Set(groups[0].members)).toEqual(new Set(['typescript', 'javascript']));
    });

    it('transferClass/transferTier/transferBasis are always null — category groups carry no relationship typing', async () => {
        const pool = fakePool([
            { canonical_name: 'anthropic_claude', category: 'ai_platform' },
            { canonical_name: 'openai',            category: 'ai_platform' },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const groups = await repo.loadCategoryGroups();
        expect(groups[0].transferClass).toBeNull();
        expect(groups[0].transferTier).toBeNull();
        expect(groups[0].transferBasis).toBeNull();
    });
});

describe('TechnologyOntologyRepository.loadTransferGroups', () => {
    it('returns [] when relationships table is empty', async () => {
        const pool = fakePool([]);
        const repo = new TechnologyOntologyRepository(pool as never);
        expect(await repo.loadTransferGroups()).toEqual([]);
        expect(pool.calls[0].sql).toContain('FROM technology_relationships');
    });

    it('selects the typed transfer columns from technology_relationships (migration 120)', async () => {
        const pool = fakePool([]);
        const repo = new TechnologyOntologyRepository(pool as never);
        await repo.loadTransferGroups();
        const sql = pool.calls[0].sql;
        expect(sql).toContain('transfer_class');
        expect(sql).toContain('transfer_tier');
        expect(sql).toContain('transfer_basis');
    });

    it('merges a triangle of edges into one component', async () => {
        // claude↔openai, bedrock↔openai, claude↔bedrock — should all merge
        const pool = fakePool([
            { from_name: 'anthropic_claude', to_name: 'openai',      transfer_class: null, transfer_tier: null, transfer_basis: null },
            { from_name: 'aws_bedrock',      to_name: 'openai',      transfer_class: null, transfer_tier: null, transfer_basis: null },
            { from_name: 'anthropic_claude', to_name: 'aws_bedrock', transfer_class: null, transfer_tier: null, transfer_basis: null },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const groups = await repo.loadTransferGroups();
        expect(groups).toHaveLength(1);
        expect(new Set(groups[0].members)).toEqual(
            new Set(['anthropic_claude', 'openai', 'aws_bedrock']),
        );
    });

    it('keeps disconnected components separate', async () => {
        const pool = fakePool([
            { from_name: 'anthropic_claude', to_name: 'openai',    transfer_class: null, transfer_tier: null, transfer_basis: null },
            { from_name: 'typescript',       to_name: 'javascript', transfer_class: null, transfer_tier: null, transfer_basis: null },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const groups = await repo.loadTransferGroups();
        expect(groups).toHaveLength(2);
        const sets = groups.map(g => new Set(g.members));
        const claudeGroup = sets.find(s => s.has('anthropic_claude'));
        const tsGroup = sets.find(s => s.has('typescript'));
        expect(claudeGroup).toEqual(new Set(['anthropic_claude', 'openai']));
        expect(tsGroup).toEqual(new Set(['typescript', 'javascript']));
    });

    it('lowercases canonical names', async () => {
        const pool = fakePool([
            { from_name: 'Anthropic_Claude', to_name: 'OpenAI', transfer_class: null, transfer_tier: null, transfer_basis: null },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const groups = await repo.loadTransferGroups();
        expect(new Set(groups[0].members)).toEqual(new Set(['anthropic_claude', 'openai']));
    });

    it('carries typed metadata (class/tier/basis) from a typed edge onto its component', async () => {
        const pool = fakePool([
            { from_name: 'terraform', to_name: 'aws_cdk', transfer_class: 'iac-declarative', transfer_tier: 'full', transfer_basis: 'Declarative infrastructure-as-code transfers directly' },
            { from_name: 'aws_cdk',   to_name: 'terraform', transfer_class: 'iac-declarative', transfer_tier: 'full', transfer_basis: 'Declarative infrastructure-as-code transfers directly' },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const groups = await repo.loadTransferGroups();
        expect(groups).toHaveLength(1);
        expect(groups[0].transferClass).toBe('iac-declarative');
        expect(groups[0].transferTier).toBe('full');
        expect(groups[0].transferBasis).toBe('Declarative infrastructure-as-code transfers directly');
    });

    it('untyped (legacy) edges produce transferClass/transferTier/transferBasis: null — backwards compatible', async () => {
        const pool = fakePool([
            { from_name: 'anthropic_claude', to_name: 'openai', transfer_class: null, transfer_tier: null, transfer_basis: null },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const groups = await repo.loadTransferGroups();
        expect(groups[0].transferClass).toBeNull();
        expect(groups[0].transferTier).toBeNull();
        expect(groups[0].transferBasis).toBeNull();
    });

    it('two typed classes sharing a member stay two groups (typed groups are built by class, not connectivity)', async () => {
        // a<->b is class-one, b<->c is class-two — b is shared, but connectivity
        // must NOT merge the two classes into one group.
        const pool = fakePool([
            { from_name: 'a', to_name: 'b', transfer_class: 'class-one', transfer_tier: 'full',    transfer_basis: 'basis-one' },
            { from_name: 'b', to_name: 'c', transfer_class: 'class-two', transfer_tier: 'partial', transfer_basis: 'basis-two' },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const groups = await repo.loadTransferGroups();
        expect(groups).toHaveLength(2);
        const one = groups.find((g) => g.transferClass === 'class-one');
        const two = groups.find((g) => g.transferClass === 'class-two');
        expect(new Set(one?.members)).toEqual(new Set(['a', 'b']));
        expect(one?.transferTier).toBe('full');
        expect(one?.transferBasis).toBe('basis-one');
        expect(new Set(two?.members)).toEqual(new Set(['b', 'c']));
        expect(two?.transferTier).toBe('partial');
        expect(two?.transferBasis).toBe('basis-two');
    });

    it('a stray untyped edge bridging a typed class to an unrelated component does NOT leak metadata either way', async () => {
        // aws_bedrock<->anthropic_claude is the typed 'ai-provider' class (migration 120).
        // aws_bedrock<->aws_vpc is an untyped structural edge (e.g. legacy part_of),
        // bridging aws_bedrock into an unrelated untyped component containing aws_vpc/terraform.
        const pool = fakePool([
            { from_name: 'aws_bedrock', to_name: 'anthropic_claude', transfer_class: 'ai-provider', transfer_tier: 'full', transfer_basis: 'LLM API usage patterns transfer directly' },
            { from_name: 'anthropic_claude', to_name: 'aws_bedrock', transfer_class: 'ai-provider', transfer_tier: 'full', transfer_basis: 'LLM API usage patterns transfer directly' },
            { from_name: 'aws_bedrock', to_name: 'aws_vpc', transfer_class: null, transfer_tier: null, transfer_basis: null },
            { from_name: 'aws_vpc', to_name: 'terraform', transfer_class: null, transfer_tier: null, transfer_basis: null },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const groups = await repo.loadTransferGroups();
        expect(groups).toHaveLength(2);

        const typed = groups.find((g) => g.transferClass === 'ai-provider');
        expect(new Set(typed?.members)).toEqual(new Set(['aws_bedrock', 'anthropic_claude']));
        expect(typed?.transferTier).toBe('full');
        expect(typed?.transferBasis).toBe('LLM API usage patterns transfer directly');

        const untyped = groups.find((g) => g.transferClass === null);
        // aws_bedrock legitimately appears in BOTH groups; the untyped component
        // itself must not absorb anthropic_claude nor carry the typed metadata.
        expect(new Set(untyped?.members)).toEqual(new Set(['aws_bedrock', 'aws_vpc', 'terraform']));
        expect(untyped?.members).not.toContain('anthropic_claude');
        expect(untyped?.transferTier).toBeNull();
        expect(untyped?.transferBasis).toBeNull();
    });

    it('when a typed class has disagreeing non-null transfer_tier/transfer_basis, the FIRST wins and a warning is logged once each', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const pool = fakePool([
            { from_name: 'a', to_name: 'b', transfer_class: 'class-one', transfer_tier: 'full',    transfer_basis: 'basis-one' },
            { from_name: 'b', to_name: 'a', transfer_class: 'class-one', transfer_tier: 'partial', transfer_basis: 'basis-two' },
        ]);
        const repo = new TechnologyOntologyRepository(pool as never);
        const groups = await repo.loadTransferGroups();
        expect(groups).toHaveLength(1);
        expect(groups[0].transferClass).toBe('class-one');
        expect(groups[0].transferTier).toBe('full');
        expect(groups[0].transferBasis).toBe('basis-one');
        expect(warnSpy).toHaveBeenCalledTimes(2); // one for tier, one for basis
        warnSpy.mockRestore();
    });

    it('selects rows ordered by transfer_class/from_id/to_id for deterministic grouping', async () => {
        const pool = fakePool([]);
        const repo = new TechnologyOntologyRepository(pool as never);
        await repo.loadTransferGroups();
        expect(pool.calls[0].sql).toContain('ORDER BY r.transfer_class, r.from_id, r.to_id');
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
