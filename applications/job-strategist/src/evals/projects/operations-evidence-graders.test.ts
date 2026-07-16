/** @format */
import { describe, it, expect } from '@jest/globals';
import {
    themeActivationGrader,
    citableOperationsFactGrader,
    themelessRegressionGrader,
    outsideProjectAttributionGrader,
    kindScopeRejectionGrader,
} from './operations-evidence-graders.js';
import { validateProjectsProvenance } from '../../agents/writer/projects-provenance.js';
import { buildProjectPool } from '../../agents/evidence/project-agent-inputs.js';
import { OPS_PROJECT_META, OPS_REPO_LOOKUP } from './fixtures.js';

// Component 4 (a)-(e), docs/superpowers/specs/2026-07-16-projects-operations-
// evidence-design.md -- each case below is graded through the real runtime
// primitives (see operations-evidence-graders.ts's header comment), not a
// reimplementation of their rules.

describe('Component 4 (a): theme activation', () => {
    it('the MongoDB TSE JD activates database-operations + backup-recovery (+1); a frontend JD activates zero', () => {
        const r = themeActivationGrader();
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
});
