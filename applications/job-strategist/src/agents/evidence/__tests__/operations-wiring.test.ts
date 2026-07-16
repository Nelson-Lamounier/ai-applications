/**
 * @format
 * Regression test for the FOLDED-IN review finding on Task 3: the wiring
 * ORDER run-pipeline.ts's projects-pool build depends on (meta loaded BEFORE
 * `gatherOperationsEvidence` runs; the gather's matches APPENDED to
 * `verifiedMatches` BEFORE `buildProjectPool` runs) was previously proven
 * only by inspection of `buildProjectAgentInputsWithOperationsEvidence`'s
 * source. That function itself is not safely importable from Jest (it lives
 * in run-pipeline.ts, whose module graph pulls in pdf-parse ->
 * @napi-rs/canvas's native binding -- see the note on
 * `__tests__/experience-weave-scope.test.ts`), so its pure ordering/append
 * logic was extracted into `buildProjectAgentInputsFromMeta`
 * (operations-wiring.ts) specifically so it could be driven here, against
 * the REAL function, with a fake retrieve + fixture meta -- not a
 * reimplementation of the ordering it is meant to prove.
 */
import { describe, it, expect, jest } from '@jest/globals';
import type { JdSignal } from '@bedrock/shared';
import { buildProjectAgentInputsFromMeta, jdStringsForThemes, type WiringLogger } from '../operations-wiring.js';
import type { ProjectAgentMeta, RepoLookupRow, VerifiedMatch } from '../project-agent-inputs.js';
import type { RetrievedPassage } from '../operations-evidence.js';

function mongoJd(overrides: Partial<JdSignal> = {}): JdSignal {
    return {
        targetRole: 'Technical Support Engineer',
        seniority: 'mid',
        domain: 'database-support',
        companyProblem: 'Keep production MongoDB deployments healthy for customers.',
        dimensionMix: { customerFacing: 30, technical: 50, aiMl: 0, supportOps: 20, monitoring: 0 },
        hardRequirements: [
            { skill: 'MongoDB administration', context: 'production support', disqualifying: true },
            { skill: 'backup and recovery', context: 'disaster recovery planning', disqualifying: false },
        ],
        softRequirements: [],
        implicitRequirements: [],
        technologyInventory: { languages: [], frameworks: [], infrastructure: [], tools: [], methodologies: [] },
        experienceSignals: { yearsExpected: '3+', domainExperience: 'database support', leadershipExpectation: '', scaleIndicators: '' },
        requiredSkills: ['MongoDB'],
        preferredSkills: ['PostgreSQL replication'],
        tools: [],
        concepts: ['disaster recovery planning'],
        responsibilities: [],
        retrievalKeywords: ['mongodb', 'database'],
        ...overrides,
    };
}

function meta(overrides: Partial<ProjectAgentMeta> = {}): ProjectAgentMeta {
    return {
        projectId: 'proj-infra',
        name: 'Infra Platform',
        pitch: 'Owns the production database and pgbouncer connection layer.',
        tagline: '',
        repositoryIds: ['repo-infra'],
        repoFullNames: ['o/infra-platform'],
        repoKinds: new Map([['o/infra-platform', 'infra']]),
        ...overrides,
    };
}

const repoLookup: ReadonlyMap<string, RepoLookupRow> = new Map([
    ['o/infra-platform', { id: 'repo-infra', githubRepoId: 100 }],
]);

function silentLogger(): WiringLogger {
    return { info: jest.fn(), warn: jest.fn() };
}

describe('buildProjectAgentInputsFromMeta -- wiring order + append semantics (folded review finding)', () => {
    it('a research-match fact AND a theme fact both land in the pool, each attributed to the right project -- proving activate-before-gather and append-before-buildProjectPool', async () => {
        const researchMatch: VerifiedMatch = {
            skill: 'DNS', sourceCitation: 'o/infra-platform/infra/dns.ts', evidenceFiles: ['o/infra-platform/infra/dns.ts'],
        };
        const opsPassage: RetrievedPassage = {
            file: 'o/infra-platform/docs/database-operations.md',
            text: 'Runbook: pgbouncer runs in transaction pooling mode in front of the production PostgreSQL cluster.',
        };
        const retrieve = jest.fn<() => Promise<ReadonlyArray<RetrievedPassage>>>().mockResolvedValue([opsPassage]);

        const { projectAgentInputs, themesDiag } = await buildProjectAgentInputsFromMeta({
            bulletSets: [{ name: 'Infra Platform', bullets: ['Operated the production Kubernetes cluster.'] }],
            projectMeta: [meta()],
            repoLookup,
            verifiedMatches: [researchMatch],
            jd: mongoJd(),
            pipelineRunId: 'run-1',
            applicationId: 'app-1',
            log: silentLogger(),
            buildRetrieve: () => retrieve,
        });

        // activateThemes ran (mongoJd hits database-operations + backup-recovery).
        expect(themesDiag.activated).toEqual(expect.arrayContaining(['database-operations']));

        const pool = projectAgentInputs.pool;
        expect(pool).toHaveLength(1);
        const facts = pool[0]!.repoCurrent;

        // BOTH lanes present -- the research match (pre-existing verifiedMatches)
        // and the theme fact gathered from the fake retrieve -- proving append,
        // not replace.
        expect(facts.map((f) => f.skill)).toEqual(expect.arrayContaining(['DNS', 'database operations']));
        // Both attributed to the SAME (only) project -- buildProjectPool ran
        // against the union, not against verifiedMatches alone.
        expect(facts.every((f) => f.fullName === 'o/infra-platform')).toBe(true);
        // Curated bullets loaded via the pre-gather meta are still present --
        // proving meta was loaded (and usable) before the gather ran.
        expect(pool[0]!.curated.map((b) => b.text)).toEqual(['Operated the production Kubernetes cluster.']);

        expect(retrieve).toHaveBeenCalled();
    });

    it('a gather-time throw still yields the research-match fact (fail-open) -- the append step never depends on the gather succeeding', async () => {
        const researchMatch: VerifiedMatch = {
            skill: 'DNS', sourceCitation: 'o/infra-platform/infra/dns.ts', evidenceFiles: ['o/infra-platform/infra/dns.ts'],
        };
        const log = silentLogger();

        const { projectAgentInputs, themesDiag } = await buildProjectAgentInputsFromMeta({
            bulletSets: [],
            projectMeta: [meta()],
            repoLookup,
            verifiedMatches: [researchMatch],
            jd: mongoJd(),
            pipelineRunId: 'run-2',
            applicationId: 'app-2',
            log,
            buildRetrieve: () => { throw new Error('RdsVectorStore.fromEnvironment failed: missing env var'); },
        });

        const facts = projectAgentInputs.pool[0]!.repoCurrent;
        expect(facts).toHaveLength(1);
        expect(facts[0]!.skill).toBe('DNS');
        // Themes were still activated (that decision precedes the gather) but
        // zero facts were counted since the gather itself never completed.
        expect(themesDiag.activated.length).toBeGreaterThan(0);
        expect(themesDiag.factCounts).toEqual({});
        expect(log.warn).toHaveBeenCalledWith(
            expect.objectContaining({ pipelineRunId: 'run-2' }),
            'operations_evidence_failed_open',
        );
    });

    it('a themeless JD skips the gather entirely -- buildRetrieve is never invoked', async () => {
        const retrieveFactory = jest.fn(() => { throw new Error('must not be called'); });
        const { themesDiag } = await buildProjectAgentInputsFromMeta({
            bulletSets: [],
            projectMeta: [meta()],
            repoLookup,
            verifiedMatches: [],
            jd: mongoJd({ hardRequirements: [], preferredSkills: [], concepts: [] }),
            pipelineRunId: 'run-3',
            applicationId: 'app-3',
            log: silentLogger(),
            buildRetrieve: retrieveFactory,
        });

        expect(themesDiag.activated).toEqual([]);
        expect(retrieveFactory).not.toHaveBeenCalled();
    });
});

describe('jdStringsForThemes', () => {
    it('flattens hardRequirements[].skill + preferredSkills + concepts, in that order, tier-tagged', () => {
        const jd = mongoJd();
        expect(jdStringsForThemes(jd)).toEqual([
            { text: 'MongoDB administration', tier: 'disqualifying' },
            { text: 'backup and recovery', tier: 'required' },
            { text: 'PostgreSQL replication', tier: 'preferred' },
            { text: 'disaster recovery planning', tier: 'preferred' },
        ]);
    });

    it('tags a hard requirement with disqualifying: false as required, not disqualifying', () => {
        const jd = mongoJd({
            hardRequirements: [{ skill: 'Linux systems administration', context: 'production support', disqualifying: false }],
            preferredSkills: [],
            concepts: [],
        });
        expect(jdStringsForThemes(jd)).toEqual([{ text: 'Linux systems administration', tier: 'required' }]);
    });

    it('tags a hard requirement with no disqualifying field at all as required (the common case)', () => {
        const jd = mongoJd({
            hardRequirements: [{ skill: 'Linux systems administration', context: 'production support' }],
            preferredSkills: [],
            concepts: [],
        });
        expect(jdStringsForThemes(jd)).toEqual([{ text: 'Linux systems administration', tier: 'required' }]);
    });

    it('fails open on a malformed JdSignal missing tier-bearing fields -- degrades to whatever preferred-tier strings ARE present, never throws, never invents a required/disqualifying tier from absent data', () => {
        const malformed = { ...mongoJd(), hardRequirements: undefined } as unknown as JdSignal;
        expect(jdStringsForThemes(malformed)).toEqual([
            { text: 'PostgreSQL replication', tier: 'preferred' },
            { text: 'disaster recovery planning', tier: 'preferred' },
        ]);
    });

    it('fails open when ALL three tier-bearing fields are missing -- returns an empty array, not a throw', () => {
        const malformed = {
            ...mongoJd(),
            hardRequirements: undefined,
            preferredSkills: undefined,
            concepts: undefined,
        } as unknown as JdSignal;
        expect(jdStringsForThemes(malformed)).toEqual([]);
    });
});
