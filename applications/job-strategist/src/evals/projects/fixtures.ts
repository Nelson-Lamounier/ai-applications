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
import type { ProjectPoolEntry } from '../../agents/evidence/project-agent-inputs.js';
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
    { skill: 'Kubernetes', source: 'hard', verdict: 'verified', requirement: INFRA_REQUIREMENT },
    { skill: 'PostgreSQL', source: 'hard', verdict: 'verified', requirement: INFRA_REQUIREMENT },
    { skill: 'DNS', source: 'hard', verdict: 'verified', requirement: INFRA_REQUIREMENT },
];

/**
 * Passes every grader: provenance-clean (every id resolves to its own
 * project's pool), quote-faithful (assembled text below is a fresh
 * `assembleProjects` call), composition-clean (one composed bullet, in-project,
 * citing DNS -- a skill NO curated Tucaken bullet already answers), covers all
 * three ATS targets (Kubernetes via p0.b1, PostgreSQL via p0.b2, DNS via the
 * composed repo-current bullet -- 3/3, clears the min(2,3) bar), and both
 * descriptions stay under 40 words with well over 30% pitch-token overlap.
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
 * and is untouched, and the retype does not remove the "Kubernetes" token so
 * `atsCoverageGrader` (which DOES read `assembled`) still clears its bar.
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
 * Adversarial: Tucaken gets three composed highlights instead of two (DNS,
 * Redis, GraphQL -- each citing its own distinct, valid, not-already-curated
 * repo-current fact). This deliberately fails BOTH `provenanceGrader` (which
 * enforces the <=2 composed cap via `validateProjectsProvenance`) AND
 * `compositionGrader` (which enforces the identical cap as its own
 * predicate, by design -- see the comment on `compositionGrader`).
 * `quoteFidelityGrader`, `atsCoverageGrader` and `descriptionGrader` are
 * unaffected: `assembled` is a fresh `assembleProjects` call, coverage only
 * grows with the extra bullets, and descriptions are untouched.
 */
const THREE_COMPOSED_OUTPUT: ProjectsAgentOutput = {
    ...GOLDEN_OUTPUT,
    entries: [
        {
            ...GOLDEN_OUTPUT.entries[0]!,
            highlights: [
                ...GOLDEN_OUTPUT.entries[0]!.highlights,
                { text: 'Introduced Redis caching for hot read paths', sources: ['p0.r1'] },
                { text: 'Wired GraphQL schema stitching across services', sources: ['p0.r2'] },
            ],
        },
        GOLDEN_OUTPUT.entries[1]!,
    ],
};

export const ADVERSARIAL_THREE_COMPOSED: ProjectsEvalInput = {
    output: THREE_COMPOSED_OUTPUT,
    pool: POOL,
    assembled: assembleProjects(THREE_COMPOSED_OUTPUT, POOL),
    atsTargets: INFRA_TARGETS,
};
