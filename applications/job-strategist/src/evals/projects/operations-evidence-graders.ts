/**
 * @format
 * Operations-evidence eval graders -- Component 4 (a)-(e) from
 * docs/superpowers/specs/2026-07-16-projects-operations-evidence-design.md,
 * exercised against the REAL runtime primitives (`activateThemes`,
 * `gatherOperationsEvidence`, `buildProjectPool`, `validateProjectsProvenance`)
 * rather than a reimplementation of their rules, so "eval says good" can
 * never drift from "guard accepts" (same discipline as projects-graders.ts).
 * Each grader below corresponds to exactly one spec eval case.
 */
import { activateThemes, OPERATIONS_THEMES } from '../../agents/evidence/operations-themes.js';
import { gatherOperationsEvidence, type RetrievedPassage } from '../../agents/evidence/operations-evidence.js';
import { buildProjectPool, type VerifiedMatch } from '../../agents/evidence/project-agent-inputs.js';
import { validateProjectsProvenance } from '../../agents/writer/projects-provenance.js';
import type { ProjectsAgentOutput } from '../../agents/writer/projects-schema.js';
import { mkResult, type GraderResult } from '../graders.js';
import {
    MONGODB_TSE_JD_STRINGS, FRONTEND_JD_STRINGS,
    OPS_PROJECT_META, OPS_REPO_LOOKUP, PGBOUNCER_DOCS_CHUNK, OUTSIDE_PROJECT_CHUNK_FILE,
    MIXED_KIND_PROJECT_META, ML_ONLY_CHUNK,
} from './fixtures.js';

type Retrieve = (query: string, k: number) => Promise<ReadonlyArray<RetrievedPassage>>;

/** A retrieve() stub that returns the same fixed passage set on every call. */
function retrieveOnce(passages: readonly RetrievedPassage[]): Retrieve {
    return async () => passages;
}

const DATABASE_OPERATIONS_THEME = OPERATIONS_THEMES.find((t) => t.key === 'database-operations')!;

/**
 * (a) The MongoDB TSE JD activates database-operations + backup-recovery
 * (plus one more, capped at 3 by `activateThemes`); a frontend-only JD
 * activates zero -- the whole feature stays a no-op for JDs with no
 * operations angle.
 */
export function themeActivationGrader(): GraderResult {
    const mongoActivated = activateThemes(MONGODB_TSE_JD_STRINGS).map((t) => t.key);
    const frontendActivated = activateThemes(FRONTEND_JD_STRINGS);

    const failures: string[] = [];
    if (!mongoActivated.includes('database-operations')) failures.push('mongodb_jd_missing:database-operations');
    if (!mongoActivated.includes('backup-recovery')) failures.push('mongodb_jd_missing:backup-recovery');
    if (mongoActivated.length !== 3) failures.push(`mongodb_jd_theme_count:${mongoActivated.length}`);
    if (frontendActivated.length !== 0) failures.push(`frontend_jd_activated:${frontendActivated.length}`);
    return mkResult('themeActivation', failures);
}

/**
 * (b) A pgbouncer/RDS-style docs chunk from an infra repo becomes a citable
 * `[p.r]` fact through the real `gatherOperationsEvidence` -> `buildProjectPool`
 * pipeline, and a composed bullet citing that fact's id passes
 * `validateProjectsProvenance` unchanged.
 */
export async function citableOperationsFactGrader(): Promise<GraderResult> {
    const failures: string[] = [];
    const gathered = await gatherOperationsEvidence({
        themes: [DATABASE_OPERATIONS_THEME],
        projects: [OPS_PROJECT_META],
        retrieve: retrieveOnce([PGBOUNCER_DOCS_CHUNK]),
    });
    const built = buildProjectPool([], [OPS_PROJECT_META], OPS_REPO_LOOKUP, gathered.matches);
    const fact = built.pool[0]?.repoCurrent[0];
    if (!fact) return mkResult('citableOperationsFact', ['no_repo_current_fact_produced']);
    if (fact.id !== 'p0.r0') failures.push(`unexpected_fact_id:${fact.id}`);

    const output: ProjectsAgentOutput = {
        entries: [{
            name: 'Infra Platform',
            github: 'github.com/o/infra-platform',
            description: 'Owns production database operations for the platform.',
            highlights: [{ text: 'Ran pgbouncer transaction pooling in front of the production RDS PostgreSQL cluster.', sources: [fact.id] }],
        }],
    };
    failures.push(...validateProjectsProvenance(output, built.pool));
    return mkResult('citableOperationsFact', failures);
}

/**
 * (c) A themeless JD leaves the pool byte-identical to a build that never
 * calls the operations-evidence machinery at all -- the regression the
 * design's error-handling section promises ("no activated themes ... yield
 * an unchanged pool").
 */
export async function themelessRegressionGrader(): Promise<GraderResult> {
    const verifiedMatches: VerifiedMatch[] = [
        { skill: 'DNS', sourceCitation: 'o/infra-platform/infra/dns.ts', evidenceFiles: ['o/infra-platform/infra/dns.ts'] },
    ];
    const bulletSets = [{ name: 'Infra Platform', bullets: ['Operated the production Kubernetes cluster.'] }];

    const activated = activateThemes(FRONTEND_JD_STRINGS);
    const neverCalled: Retrieve = async () => { throw new Error('retrieve must not be called for a themeless JD'); };
    const gathered = await gatherOperationsEvidence({ themes: activated, projects: [OPS_PROJECT_META], retrieve: neverCalled });

    const withThemesPath = buildProjectPool(bulletSets, [OPS_PROJECT_META], OPS_REPO_LOOKUP, [...verifiedMatches, ...gathered.matches]);
    const noThemesPath = buildProjectPool(bulletSets, [OPS_PROJECT_META], OPS_REPO_LOOKUP, verifiedMatches);

    const failures = JSON.stringify(withThemesPath) === JSON.stringify(noThemesPath) ? [] : ['pool_diverged_for_themeless_jd'];
    return mkResult('themelessRegression', failures);
}

/**
 * (d) A theme fact whose file resolves to a repo OUTSIDE the project
 * attributes nowhere -- `buildProjectPool`'s fail-closed repository-id
 * attribution is the load-bearing gate here (`gatherOperationsEvidence`'s
 * own qualifying-repo filter is a first, redundant one -- this grader
 * bypasses it deliberately to prove the SECOND gate holds on its own).
 */
export function outsideProjectAttributionGrader(): GraderResult {
    const outsideMatch: VerifiedMatch = {
        skill: 'database operations',
        sourceCitation: 'Notes from an unrelated repository.',
        evidenceFiles: [OUTSIDE_PROJECT_CHUNK_FILE],
    };
    const built = buildProjectPool([], [OPS_PROJECT_META], OPS_REPO_LOOKUP, [outsideMatch]);
    const failures = built.pool[0]!.repoCurrent.length === 0 ? [] : ['outside_repo_fact_attributed'];
    return mkResult('outsideProjectAttribution', failures);
}

/**
 * (e) A chunk from an ml-kind repo is rejected for database-operations
 * (`kinds: [backend, infra]`) even though the project legitimately owns
 * that repo and the retrieved text is textually on-topic -- proves the
 * POST-retrieval repo-membership filter, not just the pre-retrieval kind
 * gate (the project also owns a qualifying infra repo, so retrieval does run).
 */
export async function kindScopeRejectionGrader(): Promise<GraderResult> {
    const gathered = await gatherOperationsEvidence({
        themes: [DATABASE_OPERATIONS_THEME],
        projects: [MIXED_KIND_PROJECT_META],
        retrieve: retrieveOnce([ML_ONLY_CHUNK]),
    });
    const failures = gathered.matches.length === 0 ? [] : [`ml_chunk_admitted:${gathered.matches.length}`];
    return mkResult('kindScopeRejection', failures);
}
