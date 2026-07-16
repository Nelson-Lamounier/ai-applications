/**
 * @format
 * Synthetic projects-agent eval fixtures - no Bedrock, no PII.
 *
 * GOLDEN_TWO_LANE is the STALENESS scenario: the curated (already-written)
 * resume-bullet pool answers two of the three JD targets (Kubernetes,
 * PostgreSQL); the third (DNS) only became true after the case study was
 * written and is attainable ONLY via a repo-current fact freshly attributed
 * from the Skill Evidence Ledger. A well-formed output must compose exactly
 * that one bullet from the repo-current lane -- proving the two-lane pool
 * (Task 2) and the ATS re-write lane (Task 7) actually reach into the fresher
 * lane rather than settling for the two targets the curated pool already covers.
 *
 * The adversarial variants each break exactly one grader's invariant (except
 * the composed-cap one, which breaks two BY DESIGN -- see the comment on it).
 */
import type { ProjectAgentMeta, ProjectPoolEntry, RepoLookupRow } from '../../agents/evidence/project-agent-inputs.js';
import type { RetrievedPassage } from '../../agents/evidence/operations-evidence.js';
import type { TieredJdString } from '../../agents/evidence/operations-themes.js';
import { assembleProjects } from '../../agents/writer/projects-provenance.js';
import type { ProjectsAgentOutput } from '../../agents/writer/projects-schema.js';
import type { ExperienceAtsTarget } from '../../ats/gate/experience-ats-targets.js';
import type { ProjectsEvalInput } from './projects-graders.js';

const INFRA_REQUIREMENT = 'Cloud infrastructure and platform tooling (Kubernetes, PostgreSQL, DNS)';

const POOL: ProjectPoolEntry[] = [
    {
        index: 0,
        name: 'Tucaken',
        pitch: 'career platform helping engineers land jobs faster through evidence grounded coaching',
        repoUrls: ['github.com/o/tucaken-app'],
        curated: [
            { id: 'p0.b0', text: 'Built the onboarding flow end to end' },
            { id: 'p0.b1', text: 'Wrote the RLS policies for multi-tenant Kubernetes clusters' },
            { id: 'p0.b2', text: 'Instrumented PostgreSQL row-level security across every write path' },
        ],
        repoCurrent: [
            { id: 'p0.r0', skill: 'DNS', sourceCitation: 'infra/dns.ts', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' },
            { id: 'p0.r1', skill: 'Redis', sourceCitation: 'infra/cache.ts', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' },
            { id: 'p0.r2', skill: 'GraphQL', sourceCitation: 'src/api/schema.ts', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' },
            // p0.r3-r6 exist ONLY to give ADVERSARIAL_OVER_CAP_COMPOSED enough
            // distinct, not-already-curated repo-current facts to genuinely
            // breach the raised (Task 3) per-entry composed cap.
            { id: 'p0.r3', skill: 'Terraform', sourceCitation: 'infra/main.tf', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' },
            { id: 'p0.r4', skill: 'RabbitMQ', sourceCitation: 'infra/queue.ts', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' },
            { id: 'p0.r5', skill: 'Elasticsearch', sourceCitation: 'src/search/es.ts', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' },
            { id: 'p0.r6', skill: 'Prometheus', sourceCitation: 'infra/metrics.ts', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' },
        ],
    },
    {
        index: 1,
        name: 'Portfolio',
        pitch: 'personal engineering portfolio showcasing production-grade infrastructure and AI pipelines',
        repoUrls: ['github.com/o/portfolio'],
        curated: [{ id: 'p1.b0', text: 'Automated CI checks across every workspace' }],
        repoCurrent: [],
    },
];

const INFRA_TARGETS: ExperienceAtsTarget[] = [
    { skill: 'Kubernetes', source: 'hard', verdict: 'verified', requirement: INFRA_REQUIREMENT, anchors: [] },
    { skill: 'PostgreSQL', source: 'hard', verdict: 'verified', requirement: INFRA_REQUIREMENT, anchors: [] },
    { skill: 'DNS', source: 'hard', verdict: 'verified', requirement: INFRA_REQUIREMENT, anchors: [] },
];

/**
 * Passes every grader: provenance-clean (every id resolves to its own
 * project's pool), quote-faithful (assembled text below is a fresh
 * `assembleProjects` call), composition-clean (one composed bullet, in-project,
 * citing DNS -- a skill NO curated Tucaken bullet already answers), covers all
 * three ATS targets (Kubernetes via p0.b1, PostgreSQL via p0.b2, DNS via the
 * composed repo-current bullet -- 3/3, clears the min(2,3) bar), and both
 * descriptions are stamp-shaped (non-empty fixed points of
 * `stampProjectDescription` at the 80-word cap -- see descriptionGrader).
 */
const GOLDEN_OUTPUT: ProjectsAgentOutput = {
    entries: [
        {
            name: 'Tucaken',
            github: 'github.com/o/tucaken-app',
            description: 'Tucaken is a career platform helping engineers land jobs faster through grounded evidence coaching workflows.',
            highlights: [
                { bulletId: 'p0.b1' },
                { bulletId: 'p0.b2' },
                { text: 'Configured DNS resolution for every production deployment', sources: ['p0.r0'] },
            ],
        },
        {
            name: 'Portfolio',
            github: 'github.com/o/portfolio',
            description: 'Portfolio is a personal engineering showcase demonstrating production infrastructure and AI pipelines work.',
            highlights: [{ bulletId: 'p1.b0' }],
        },
    ],
};

export const GOLDEN_TWO_LANE: ProjectsEvalInput = {
    output: GOLDEN_OUTPUT,
    pool: POOL,
    assembled: assembleProjects(GOLDEN_OUTPUT, POOL),
    atsTargets: INFRA_TARGETS,
};

/**
 * Component 4 (c): a COMPOSED bullet leaking an internal identifier
 * (`(RETRIEVAL_PREFILTER)`, the run fe421faf leak this whole feature is
 * driven by) -- trips ONLY `styleGrader`, nothing else (provenance/quote-
 * fidelity/composition/coverage/description are all otherwise identical to
 * GOLDEN_OUTPUT).
 */
const STYLE_DIRTY_COMPOSED_OUTPUT: ProjectsAgentOutput = {
    entries: [
        {
            ...GOLDEN_OUTPUT.entries[0]!,
            highlights: [
                { bulletId: 'p0.b1' },
                { bulletId: 'p0.b2' },
                { text: 'Reduced DNS resolution latency by tuning the (RETRIEVAL_PREFILTER) stage', sources: ['p0.r0'] },
            ],
        },
        GOLDEN_OUTPUT.entries[1]!,
    ],
};

export const STYLE_DIRTY_COMPOSED: ProjectsEvalInput = {
    output: STYLE_DIRTY_COMPOSED_OUTPUT,
    pool: POOL,
    assembled: assembleProjects(STYLE_DIRTY_COMPOSED_OUTPUT, POOL),
    atsTargets: INFRA_TARGETS,
};

/**
 * Component 4 (c): the SAME internal-identifier pattern, but on a CURATED
 * (quote-only) bullet -- byte-fidelity means it is NEVER repaired, so
 * `styleGrader` treats it as advisory-only and does NOT fail (curated
 * findings surface only via `projectsStyleDiagnostics.curatedAdvisories`,
 * never a grader failure). Proves the curated/composed exemption boundary,
 * not just that the lint itself fires.
 */
const STYLE_DIRTY_CURATED_POOL: ProjectPoolEntry[] = [
    {
        ...POOL[0]!,
        curated: [
            ...POOL[0]!.curated,
            { id: 'p0.b3', text: 'Wired the (RETRIEVAL_PREFILTER) stage into every query path' },
        ],
    },
    POOL[1]!,
];
const STYLE_DIRTY_CURATED_OUTPUT: ProjectsAgentOutput = {
    entries: [
        { ...GOLDEN_OUTPUT.entries[0]!, highlights: [...GOLDEN_OUTPUT.entries[0]!.highlights, { bulletId: 'p0.b3' }] },
        GOLDEN_OUTPUT.entries[1]!,
    ],
};

export const STYLE_DIRTY_CURATED: ProjectsEvalInput = {
    output: STYLE_DIRTY_CURATED_OUTPUT,
    pool: STYLE_DIRTY_CURATED_POOL,
    assembled: assembleProjects(STYLE_DIRTY_CURATED_OUTPUT, STYLE_DIRTY_CURATED_POOL),
    atsTargets: INFRA_TARGETS,
};

// ---------------------------------------------------------------------------
// G1 (run 976403b3): the projects agent emitted `entries` as a stringified
// JSON array (constrained-decoding slip) -> zod invalid_type -> a fourth
// consecutive fallback. This is the live failure shape verbatim: a
// well-formed `GOLDEN_OUTPUT.entries` array, but stringified rather than a
// real array -- `normaliseProjectsAgentOutput` must parse-and-substitute it
// so the paid-for generation is kept.
// ---------------------------------------------------------------------------
export const STRINGIFIED_ENTRIES_RAW_PAYLOAD: { entries: string } = {
    entries: JSON.stringify(GOLDEN_OUTPUT.entries),
};

/**
 * Adversarial: Tucaken's lead highlight cites Portfolio's curated bullet
 * (p1.b0) instead of its own (p0.b1) -- trips ONLY `provenanceGrader`
 * (`cross_project_citation`). `assembled` is a FRESH `assembleProjects` call
 * on this same mutated output, so `quoteFidelityGrader` stays tautologically
 * satisfied (it recomputes the identical truth); coverage still clears
 * min(2,3) on PostgreSQL + DNS alone, so `atsCoverageGrader` is unaffected;
 * `compositionGrader` only inspects composed highlights, so a cross-project
 * CURATED citation is invisible to it by construction.
 */
const CROSS_PROJECT_OUTPUT: ProjectsAgentOutput = {
    ...GOLDEN_OUTPUT,
    entries: [
        { ...GOLDEN_OUTPUT.entries[0]!, highlights: [{ bulletId: 'p1.b0' }, ...GOLDEN_OUTPUT.entries[0]!.highlights.slice(1)] },
        GOLDEN_OUTPUT.entries[1]!,
    ],
};

export const ADVERSARIAL_CROSS_PROJECT: ProjectsEvalInput = {
    output: CROSS_PROJECT_OUTPUT,
    pool: POOL,
    assembled: assembleProjects(CROSS_PROJECT_OUTPUT, POOL),
    atsTargets: INFRA_TARGETS,
};

/**
 * Adversarial: `output`/`pool` are UNCHANGED from the golden -- only the
 * rendered `assembled` text is retyped (the Kubernetes bullet loses its
 * hyphen: "multi-tenant" -> "multi tenant"). Trips ONLY `quoteFidelityGrader`
 * (byte-identical check); every other grader reads `output`/`pool` directly
 * and is untouched -- `atsCoverageGrader` now scores `output`/`pool` via
 * `scoreProjectsCoverage` (FIX 3, not `assembled`), so it is structurally
 * unaffected by a retyped render, not merely coincidentally unaffected.
 */
const RETYPED_ASSEMBLED: ReturnType<typeof assembleProjects> = assembleProjects(GOLDEN_OUTPUT, POOL).map((entry, i) =>
    i === 0 ? { ...entry, highlights: [entry.highlights[0]!.replace('multi-tenant', 'multi tenant'), ...entry.highlights.slice(1)] } : entry,
);

export const ADVERSARIAL_RETYPED_QUOTE: ProjectsEvalInput = {
    output: GOLDEN_OUTPUT,
    pool: POOL,
    assembled: RETYPED_ASSEMBLED,
    atsTargets: INFRA_TARGETS,
};

/**
 * Adversarial: Tucaken gets seven composed highlights (DNS, Redis, GraphQL,
 * Terraform, RabbitMQ, Elasticsearch, Prometheus -- each citing its own
 * distinct, valid, not-already-curated repo-current fact), one over Task 3's
 * raised per-entry cap (`PROJECTS_MAX_BULLETS_PER_ENTRY`, currently 6). This
 * deliberately fails BOTH `provenanceGrader` (which enforces the cap via
 * `validateProjectsProvenance`'s `composed_cap` AND `bullet_count` -- nine
 * highlights total also breaches the general per-entry bullet count) AND
 * `compositionGrader` (which enforces the identical cap as its own
 * predicate, by design -- see the comment on `compositionGrader`).
 * `quoteFidelityGrader`, `atsCoverageGrader` and `descriptionGrader` are
 * unaffected: `assembled` is a fresh `assembleProjects` call, coverage only
 * grows with the extra bullets, and descriptions are untouched.
 */
const OVER_CAP_COMPOSED_OUTPUT: ProjectsAgentOutput = {
    ...GOLDEN_OUTPUT,
    entries: [
        {
            ...GOLDEN_OUTPUT.entries[0]!,
            highlights: [
                ...GOLDEN_OUTPUT.entries[0]!.highlights,
                { text: 'Introduced Redis caching for hot read paths', sources: ['p0.r1'] },
                { text: 'Wired GraphQL schema stitching across services', sources: ['p0.r2'] },
                { text: 'Provisioned Terraform-managed infrastructure for every environment', sources: ['p0.r3'] },
                { text: 'Wired RabbitMQ consumers for asynchronous job processing', sources: ['p0.r4'] },
                { text: 'Indexed search documents into an Elasticsearch cluster', sources: ['p0.r5'] },
                { text: 'Instrumented Prometheus metrics across every service', sources: ['p0.r6'] },
            ],
        },
        GOLDEN_OUTPUT.entries[1]!,
    ],
};

export const ADVERSARIAL_OVER_CAP_COMPOSED: ProjectsEvalInput = {
    output: OVER_CAP_COMPOSED_OUTPUT,
    pool: POOL,
    assembled: assembleProjects(OVER_CAP_COMPOSED_OUTPUT, POOL),
    atsTargets: INFRA_TARGETS,
};

// ---------------------------------------------------------------------------
// Task 5 (c): fail-closed provenance -- three DIFFERENT violation branches
// from the existing ADVERSARIAL_CROSS_PROJECT above (a CURATED cross-project
// citation): an id that resolves nowhere in the pool, a COMPOSED highlight
// citing another project's id, and a pool that documents nothing at all.
// ---------------------------------------------------------------------------

const UNKNOWN_ID_OUTPUT: ProjectsAgentOutput = {
    entries: [
        {
            ...GOLDEN_OUTPUT.entries[0]!,
            highlights: [
                ...GOLDEN_OUTPUT.entries[0]!.highlights.slice(0, 2),
                { text: 'Cites a fact that resolves nowhere in the pool', sources: ['p0.r99'] },
            ],
        },
        GOLDEN_OUTPUT.entries[1]!,
    ],
};

/** Trips provenanceGrader's `unknown_bullet` branch -- a composed source id
 *  that is not in the global index at all (not merely owned by someone else). */
export const ADVERSARIAL_UNKNOWN_ID: ProjectsEvalInput = {
    output: UNKNOWN_ID_OUTPUT,
    pool: POOL,
    assembled: assembleProjects(UNKNOWN_ID_OUTPUT, POOL),
    atsTargets: INFRA_TARGETS,
};

const CROSS_PROJECT_COMPOSED_OUTPUT: ProjectsAgentOutput = {
    entries: [
        {
            ...GOLDEN_OUTPUT.entries[0]!,
            highlights: [
                ...GOLDEN_OUTPUT.entries[0]!.highlights.slice(0, 2),
                { text: 'Cites a Portfolio-owned curated bullet from inside the Tucaken entry', sources: ['p1.b0'] },
            ],
        },
        GOLDEN_OUTPUT.entries[1]!,
    ],
};

/** Trips provenanceGrader's `cross_project_citation` branch via the COMPOSED
 *  (sources[]) path -- ADVERSARIAL_CROSS_PROJECT above only exercises the
 *  CURATED (bulletId) path; `checkCitation` is shared by both, but a
 *  regression could still break one call site and not the other. */
export const ADVERSARIAL_CROSS_PROJECT_COMPOSED: ProjectsEvalInput = {
    output: CROSS_PROJECT_COMPOSED_OUTPUT,
    pool: POOL,
    assembled: assembleProjects(CROSS_PROJECT_COMPOSED_OUTPUT, POOL),
    atsTargets: INFRA_TARGETS,
};

/** Trips provenanceGrader's `unknown_project` branch for EVERY entry -- a
 *  totally empty pool (no documented projects at all) must still fail
 *  closed rather than vacuously accepting whatever the model emitted. */
export const ADVERSARIAL_EMPTY_POOL: ProjectsEvalInput = {
    output: GOLDEN_OUTPUT,
    pool: [],
    assembled: assembleProjects(GOLDEN_OUTPUT, []),
    atsTargets: INFRA_TARGETS,
};

// ---------------------------------------------------------------------------
// Task 5 (d): JD-ranked ordering -- a pool listing the LESS JD-relevant
// project first (Frontend) must still be reordered to the JD-relevant
// project (Platform) first by `deterministicProjects` (projects-ats-flow.ts).
// ---------------------------------------------------------------------------

export const K8S_ORDERING_TARGETS: ExperienceAtsTarget[] = [
    { skill: 'Kubernetes', source: 'hard', verdict: 'verified', requirement: 'Container orchestration', anchors: [] },
];

/** Pool order is deliberately Frontend-then-Platform -- the reverse of the
 *  expected output order -- so a passing assertion proves a genuine
 *  reorder, not an accidental preservation of input order. */
export const K8S_ORDERING_POOL: ProjectPoolEntry[] = [
    {
        index: 0,
        name: 'Frontend',
        pitch: 'marketing site built with a static site generator',
        repoUrls: ['github.com/o/frontend'],
        curated: [{ id: 'p0.b0', text: 'Redesigned the landing page hero section for conversion' }],
        repoCurrent: [],
    },
    {
        index: 1,
        name: 'Platform',
        pitch: 'internal platform running every production workload on managed infrastructure',
        repoUrls: ['github.com/o/platform'],
        curated: [{ id: 'p1.b0', text: 'Operated multi-tenant Kubernetes clusters for every production workload' }],
        repoCurrent: [],
    },
];

// ---------------------------------------------------------------------------
// Task 5 (f): lane-mix coverage -- a JD-relevant fact in the CURATED lane
// beats an off-JD fact in the COMPOSED lane, and vice versa. Both directions
// share one pool so the only thing that changes between the two outputs is
// WHICH lane carries the JD-relevant fact.
// ---------------------------------------------------------------------------

const LANE_MIX_POOL: ProjectPoolEntry[] = [
    {
        index: 0,
        name: 'Tucaken',
        pitch: 'career platform helping engineers land jobs faster through evidence grounded coaching',
        repoUrls: ['github.com/o/tucaken-app'],
        curated: [
            { id: 'p0.b0', text: 'Designed the GraphQL schema powering every client query' },
            { id: 'p0.b1', text: 'Wrote onboarding copy for first-time users' },
        ],
        repoCurrent: [
            { id: 'p0.r0', skill: 'Redis', sourceCitation: 'infra/cache.ts', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' },
            { id: 'p0.r1', skill: 'GraphQL', sourceCitation: 'src/api/schema.ts', repositoryId: 'r1', githubRepoId: 1, fullName: 'o/tucaken-app' },
        ],
    },
];

export const LANE_MIX_TARGETS: ExperienceAtsTarget[] = [
    { skill: 'GraphQL', source: 'hard', verdict: 'verified', requirement: 'API layer', anchors: [] },
];

/** Direction 1: the JD-relevant fact (GraphQL) is CURATED; the composed
 *  highlight cites a genuinely off-JD fact (Redis). Coverage must come from
 *  the curated lane. */
export const LANE_MIX_CURATED_WINS: { output: ProjectsAgentOutput; pool: readonly ProjectPoolEntry[] } = {
    output: {
        entries: [{
            name: 'Tucaken', github: 'github.com/o/tucaken-app', description: '',
            highlights: [
                { bulletId: 'p0.b0' },
                { text: 'Introduced Redis caching for hot read paths', sources: ['p0.r0'] },
            ],
        }],
    },
    pool: LANE_MIX_POOL,
};

/** Direction 2 (vice versa): the JD-relevant fact (GraphQL) is COMPOSED, freshly
 *  attributed from the repo-current lane; the curated bullet cited is
 *  genuinely off-JD (onboarding copy). Coverage must come from the composed lane. */
export const LANE_MIX_COMPOSED_WINS: { output: ProjectsAgentOutput; pool: readonly ProjectPoolEntry[] } = {
    output: {
        entries: [{
            name: 'Tucaken', github: 'github.com/o/tucaken-app', description: '',
            highlights: [
                { bulletId: 'p0.b1' },
                { text: 'Wired GraphQL schema stitching across every backend service', sources: ['p0.r1'] },
            ],
        }],
    },
    pool: LANE_MIX_POOL,
};

// ---------------------------------------------------------------------------
// Task 5 (g): composed-uncapped entry -- ALL SIX highlight slots composed
// (zero curated), exactly at PROJECTS_MAX_BULLETS_PER_ENTRY, every citation
// valid and in-project -- proves the Task 3 lane-mix contract that a project
// may be entirely repo-current evidence, not just "curated plus up to two".
// ---------------------------------------------------------------------------

const ALL_COMPOSED_OUTPUT: ProjectsAgentOutput = {
    entries: [
        {
            name: 'Tucaken', github: 'github.com/o/tucaken-app', description: GOLDEN_OUTPUT.entries[0]!.description,
            highlights: [
                { text: 'Configured DNS resolution for every production deployment', sources: ['p0.r0'] },
                { text: 'Introduced Redis caching for hot read paths', sources: ['p0.r1'] },
                { text: 'Wired GraphQL schema stitching across services', sources: ['p0.r2'] },
                { text: 'Provisioned Terraform-managed infrastructure for every environment', sources: ['p0.r3'] },
                { text: 'Wired RabbitMQ consumers for asynchronous job processing', sources: ['p0.r4'] },
                { text: 'Indexed search documents into an Elasticsearch cluster', sources: ['p0.r5'] },
            ],
        },
        GOLDEN_OUTPUT.entries[1]!,
    ],
};

/** ATS targets scoped to facts this fixture's composed lane actually carries
 *  (DNS, Redis) -- unlike INFRA_TARGETS (Kubernetes/PostgreSQL/DNS), which
 *  this all-composed entry would only partially cover, letting the fixture
 *  pass every grader cleanly, not just provenance/composition. */
const COMPOSED_ONLY_TARGETS: ExperienceAtsTarget[] = [
    { skill: 'DNS', source: 'hard', verdict: 'verified', requirement: INFRA_REQUIREMENT, anchors: [] },
    { skill: 'Redis', source: 'hard', verdict: 'verified', requirement: INFRA_REQUIREMENT, anchors: [] },
];

export const ALL_COMPOSED_UNCAPPED: ProjectsEvalInput = {
    output: ALL_COMPOSED_OUTPUT,
    pool: POOL,
    assembled: assembleProjects(ALL_COMPOSED_OUTPUT, POOL),
    atsTargets: COMPOSED_ONLY_TARGETS,
};

// ---------------------------------------------------------------------------
// Task 3 (Component 4 evals (a)-(e)): operations-evidence -- fixtures for
// docs/superpowers/specs/2026-07-16-projects-operations-evidence-design.md's
// Component 4 eval cases, exercised end to end through the REAL runtime
// primitives (activateThemes, gatherOperationsEvidence, buildProjectPool,
// validateProjectsProvenance) in operations-evidence-graders.ts -- never a
// reimplementation of their rules.
//
// Task 1 (docs/superpowers/specs/2026-07-16-projects-narrative-quality-
// design.md, Component 1) made `activateThemes` tier-weighted (disqualifying
// = 3, required = 2, preferred = 1) and raised the cap 3 -> 4; the strings
// below are tier-tagged `TieredJdString[]` accordingly, mirroring the
// `jdStringsForThemes` (operations-wiring.ts) mapping: hardRequirements[].skill
// with disqualifying=true -> 'disqualifying', other hardRequirements ->
// 'required', preferredSkills + concepts -> 'preferred'.
// ---------------------------------------------------------------------------

/** (a) MongoDB TSE JD, tier-tagged -- regression fixture for live run
 *  fe421faf: under the OLD raw-hit-count ranking + cap 3, networking-protocols
 *  (a single required-tier hit) lost the top-3 cut to themes accumulated from
 *  preferred-tier concept strings alone. Must now activate database-operations
 *  (disqualifying) + backup-recovery (required) + networking-protocols
 *  (required) + one more, capped at 4. */
export const MONGODB_TSE_JD_STRINGS: readonly TieredJdString[] = [
    { text: 'MongoDB administration', tier: 'disqualifying' },
    { text: 'backup and recovery', tier: 'required' },
    { text: 'networking (DNS, TCP/IP, SSL/TLS)', tier: 'required' },
    { text: 'PostgreSQL replication', tier: 'preferred' },
    { text: 'disaster recovery planning', tier: 'preferred' },
    { text: 'performance tuning', tier: 'preferred' },
    { text: 'Kubernetes', tier: 'preferred' },
];

/** (a) A frontend-only JD -- must activate ZERO operations themes regardless
 *  of tier (no operations-angle matchTerms anywhere in the vocabulary). */
export const FRONTEND_JD_STRINGS: readonly TieredJdString[] = [
    { text: 'React', tier: 'required' },
    { text: 'CSS', tier: 'required' },
    { text: 'web vitals', tier: 'preferred' },
    { text: 'accessibility', tier: 'preferred' },
    { text: 'responsive design', tier: 'preferred' },
];

/** (b) GENERALITY: a data-engineering JD -- proves tier weighting is generic,
 *  not MongoDB-coupled. `storage` (required, ONE hit) must outrank
 *  `cluster-orchestration` (preferred, TWO hits) despite fewer raw hits --
 *  the same "tier beats raw concept-accumulation" property as (a), on
 *  entirely different vocabulary. `database-operations` (disqualifying, ONE
 *  hit) still tops the ranking outright. */
export const DATA_ENGINEERING_JD_STRINGS: readonly TieredJdString[] = [
    { text: 'ETL pipelines and database administration', tier: 'disqualifying' }, // -> database-operations
    { text: 'storage systems administration', tier: 'required' },                 // -> storage
    { text: 'cluster orchestration workflows', tier: 'preferred' },               // -> cluster-orchestration (hit 1)
    { text: 'kubernetes operators', tier: 'preferred' },                          // -> cluster-orchestration (hit 2)
    { text: 'query performance tuning', tier: 'preferred' },                      // -> performance-tuning
    { text: 'network protocols', tier: 'preferred' },                            // -> networking-protocols
];

/** (b)/(c)/(d) A single-repo infra project -- 'o/infra-platform' is a member
 *  of database-operations' target kinds ([backend, infra]). */
export const OPS_PROJECT_META: ProjectAgentMeta = {
    projectId: 'proj-infra',
    name: 'Infra Platform',
    pitch: 'Owns the production RDS and pgbouncer connection layer.',
    tagline: '',
    repositoryIds: ['repo-infra'],
    repoFullNames: ['o/infra-platform'],
    repoKinds: new Map([['o/infra-platform', 'infra']]),
};

export const OPS_REPO_LOOKUP: ReadonlyMap<string, RepoLookupRow> = new Map([
    ['o/infra-platform', { id: 'repo-infra', githubRepoId: 100 }],
]);

/** (b) A pgbouncer/RDS-style docs chunk from the infra repo -- exactly the
 *  shape `gatherOperationsEvidence`'s `retrieve()` contract expects. */
export const PGBOUNCER_DOCS_CHUNK: RetrievedPassage = {
    file: 'o/infra-platform/docs/database-operations.md',
    text: 'Runbook: pgbouncer runs in transaction pooling mode in front of the '
        + 'production RDS PostgreSQL cluster, with automated snapshot backups.',
};

/** (d) A file path resolving to a repo the Infra Platform project does NOT
 *  own -- proves fail-closed attribution reuse at `buildProjectPool`, the
 *  same load-bearing gate every other `VerifiedMatch` goes through. */
export const OUTSIDE_PROJECT_CHUNK_FILE = 'o/someone-elses-repo/docs/db.md';

/** (e) A project owning BOTH an infra repo (qualifies for database-operations)
 *  and an ml repo (does not) -- proves the ml-repo chunk is rejected by
 *  `gatherOperationsEvidence`'s POST-retrieval repo-membership filter, not
 *  merely by the pre-retrieval kind gate never firing. */
export const MIXED_KIND_PROJECT_META: ProjectAgentMeta = {
    ...OPS_PROJECT_META,
    projectId: 'proj-mixed',
    name: 'Mixed Platform',
    repositoryIds: ['repo-infra', 'repo-ml'],
    repoFullNames: ['o/infra-platform', 'o/ml-platform'],
    repoKinds: new Map([
        ['o/infra-platform', 'infra'],
        ['o/ml-platform', 'ml'],
    ]),
};

/** (e) A chunk from the ml repo, textually on-topic for database-operations
 *  ("connection pooling") -- must still be rejected, since 'ml' is not in
 *  database-operations' `kinds: [backend, infra]`. */
export const ML_ONLY_CHUNK: RetrievedPassage = {
    file: 'o/ml-platform/docs/database-notes.md',
    text: 'Notes on database connection pooling from the ml training pipeline perspective.',
};
