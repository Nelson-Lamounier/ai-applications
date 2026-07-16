/** @format */
import { describe, it, expect } from '@jest/globals';
import {
    themeActivationGrader,
    generalityTierActivationGrader,
    citableOperationsFactGrader,
    themelessRegressionGrader,
    outsideProjectAttributionGrader,
    kindScopeRejectionGrader,
} from './operations-evidence-graders.js';
import { validateProjectsProvenance } from '../../agents/writer/projects-provenance.js';
import { buildProjectPool } from '../../agents/evidence/project-agent-inputs.js';
import { activateThemes, type TieredJdString } from '../../agents/evidence/operations-themes.js';
import { OPS_PROJECT_META, OPS_REPO_LOOKUP, DATA_ENGINEERING_JD_STRINGS } from './fixtures.js';

// Component 4 (a)-(e), docs/superpowers/specs/2026-07-16-projects-operations-
// evidence-design.md -- each case below is graded through the real runtime
// primitives (see operations-evidence-graders.ts's header comment), not a
// reimplementation of their rules. Task 1 (docs/superpowers/specs/2026-07-16-
// projects-narrative-quality-design.md, Component 1) made `activateThemes`
// tier-weighted; (a) is extended and (b)'s generality case is new.

describe('Component 4 (a): tier-weighted theme activation', () => {
    it('the MongoDB TSE JD activates database-operations + backup-recovery + networking-protocols (+1), capped at 4; a frontend JD activates zero', () => {
        const r = themeActivationGrader();
        expect(r.failures).toEqual([]);
        expect(r.pass).toBe(true);
    });
});

describe('Component 4 (b): GENERALITY -- tier weighting on a non-MongoDB JD', () => {
    it('a data-engineering JD activates by tier, not by raw concept count', () => {
        const r = generalityTierActivationGrader();
        expect(r.failures).toEqual([]);
        expect(r.pass).toBe(true);
    });
});

describe('Component 4 (b): citable operations fact + provenance-valid composed bullet', () => {
    it('a pgbouncer/RDS-style docs chunk becomes a [p.r] fact and a bullet citing it passes provenance', async () => {
        const r = await citableOperationsFactGrader();
        expect(r.failures).toEqual([]);
        expect(r.pass).toBe(true);
    });
});

describe('Component 4 (c): themeless JD regression', () => {
    it('a themeless JD leaves the pool byte-identical to a build that never gathers operations evidence', async () => {
        const r = await themelessRegressionGrader();
        expect(r.failures).toEqual([]);
        expect(r.pass).toBe(true);
    });
});

describe('Component 4 (d): fail-closed cross-project attribution', () => {
    it('a theme fact whose file resolves outside the project attributes nowhere', () => {
        const r = outsideProjectAttributionGrader();
        expect(r.failures).toEqual([]);
        expect(r.pass).toBe(true);
    });
});

describe('Component 4 (e): kind-scope rejection', () => {
    it('an ml-repo chunk is rejected for a [backend, infra] theme even though the project owns that repo', async () => {
        const r = await kindScopeRejectionGrader();
        expect(r.failures).toEqual([]);
        expect(r.pass).toBe(true);
    });
});

// Adversarial: none of these graders is vacuously green -- each is proven to
// fail on a genuinely broken input, not just pass on the happy path.
describe('Component 4 graders are not vacuous', () => {
    it('(b) a bullet citing a DIFFERENT project\'s id fails validateProjectsProvenance -- the same predicate citableOperationsFactGrader uses', async () => {
        // Reruns (b)'s own gather+build, then swaps the cited id for one that
        // is not in ANY pool entry -- proves the provenance check inside the
        // grader would actually catch a cross-project or unknown citation,
        // not just tautologically approve whatever id the gather produced.
        const { gatherOperationsEvidence } = await import('../../agents/evidence/operations-evidence.js');
        const { OPERATIONS_THEMES } = await import('../../agents/evidence/operations-themes.js');
        const { PGBOUNCER_DOCS_CHUNK } = await import('./fixtures.js');
        const dbTheme = OPERATIONS_THEMES.find((t) => t.key === 'database-operations')!;
        const gathered = await gatherOperationsEvidence({
            themes: [dbTheme], projects: [OPS_PROJECT_META], retrieve: async () => [PGBOUNCER_DOCS_CHUNK],
        });
        const built = buildProjectPool([], [OPS_PROJECT_META], OPS_REPO_LOOKUP, gathered.matches);
        const brokenOutput = {
            entries: [{
                name: 'Infra Platform', github: 'github.com/o/infra-platform', description: 'desc',
                highlights: [{ text: 'Cites a fact that resolves nowhere.', sources: ['p0.r99'] }],
            }],
        };
        expect(validateProjectsProvenance(brokenOutput, built.pool)).toContain('unknown_bullet:Infra Platform:p0.r99');
    });

    it('(c) the byte-identical check fails when the two builds genuinely diverge (positive control)', () => {
        const withExtra = buildProjectPool([], [OPS_PROJECT_META], OPS_REPO_LOOKUP, [
            { skill: 'DNS', sourceCitation: 'o/infra-platform/infra/dns.ts', evidenceFiles: ['o/infra-platform/infra/dns.ts'] },
        ]);
        const withoutExtra = buildProjectPool([], [OPS_PROJECT_META], OPS_REPO_LOOKUP, []);
        expect(JSON.stringify(withExtra)).not.toBe(JSON.stringify(withoutExtra));
    });

    it('(d) an INSIDE-project fact (positive control) DOES attribute -- proves the fail-closed check is discriminating, not always empty', () => {
        const insideMatch = {
            skill: 'database operations', sourceCitation: 'infra runbook',
            evidenceFiles: ['o/infra-platform/docs/db.md'],
        };
        const built = buildProjectPool([], [OPS_PROJECT_META], OPS_REPO_LOOKUP, [insideMatch]);
        expect(built.pool[0]!.repoCurrent).toHaveLength(1);
    });

    it('(a) positive control: with EVERY jd string flattened to the SAME tier (preferred), a single-hit theme genuinely loses the cap to four 3-hit themes -- proves cap4 alone does not rescue a low-raw-count theme, only tier weight does', () => {
        const untiered: TieredJdString[] = [
            { text: 'uses database technology', tier: 'preferred' },
            { text: 'administers an rdbms platform', tier: 'preferred' },
            { text: 'writes complex sql queries', tier: 'preferred' }, // -> database-operations x3
            { text: 'tracks performance metrics', tier: 'preferred' },
            { text: 'does latency analysis', tier: 'preferred' },
            { text: 'focuses on benchmarking', tier: 'preferred' }, // -> performance-tuning x3
            { text: 'manages storage volumes', tier: 'preferred' },
            { text: 'administers nas arrays', tier: 'preferred' },
            { text: 'configures ssd caching', tier: 'preferred' }, // -> storage x3
            { text: 'implements security hardening', tier: 'preferred' },
            { text: 'manages authentication flows', tier: 'preferred' },
            { text: 'configures iam policies', tier: 'preferred' }, // -> security-hardening x3
            { text: 'administers networking protocols', tier: 'preferred' }, // -> networking-protocols x1
        ];
        const activated = activateThemes(untiered).map((t) => t.key);
        expect(activated).not.toContain('networking-protocols');
        expect(activated).toEqual(['database-operations', 'performance-tuning', 'storage', 'security-hardening']);
    });

    it('(a) negative control: tagging that SAME single hit disqualifying ties it with the 3-hit themes and the ontology-order tie-break lets it into the cap -- proves tier weight, not cap4, is what rescues a required/disqualifying box', () => {
        const tiered: TieredJdString[] = [
            { text: 'uses database technology', tier: 'preferred' },
            { text: 'administers an rdbms platform', tier: 'preferred' },
            { text: 'writes complex sql queries', tier: 'preferred' },
            { text: 'tracks performance metrics', tier: 'preferred' },
            { text: 'does latency analysis', tier: 'preferred' },
            { text: 'focuses on benchmarking', tier: 'preferred' },
            { text: 'manages storage volumes', tier: 'preferred' },
            { text: 'administers nas arrays', tier: 'preferred' },
            { text: 'configures ssd caching', tier: 'preferred' },
            { text: 'implements security hardening', tier: 'preferred' },
            { text: 'manages authentication flows', tier: 'preferred' },
            { text: 'configures iam policies', tier: 'preferred' },
            { text: 'administers networking protocols', tier: 'disqualifying' }, // weight 3, ties the 3-hit preferred themes
        ];
        const activated = activateThemes(tiered).map((t) => t.key);
        expect(activated).toContain('networking-protocols');
        // security-hardening (ontology idx 4) is bumped out of the cap by
        // networking-protocols (ontology idx 3) on the tie-break.
        expect(activated).not.toContain('security-hardening');
    });

    it('(b) swapping ONLY the storage <-> cluster-orchestration tiers flips their ranking -- proves generalityTierActivationGrader is measuring tier weight, not fixture ordering', () => {
        const swapped = DATA_ENGINEERING_JD_STRINGS.map((s) => {
            if (s.text === 'storage systems administration') return { ...s, tier: 'preferred' as const };
            if (s.text === 'cluster orchestration workflows' || s.text === 'kubernetes operators') return { ...s, tier: 'required' as const };
            return s;
        });
        const activated = activateThemes(swapped).map((t) => t.key);
        const storageRank = activated.indexOf('storage');
        const clusterRank = activated.indexOf('cluster-orchestration');
        expect(storageRank).toBeGreaterThan(-1);
        expect(clusterRank).toBeGreaterThan(-1);
        // With storage demoted to preferred (weight 1 x 1 hit) and
        // cluster-orchestration promoted to required (weight 2 x 2 hits),
        // cluster-orchestration now scores higher.
        expect(clusterRank).toBeLessThan(storageRank);
    });
});
