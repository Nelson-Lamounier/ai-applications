/** @format */
jest.mock('@bedrock/shared', () => ({ runAgent: jest.fn(), log: () => undefined, PiiScrubber: jest.fn().mockImplementation(() => ({ scrub: (s: string) => ({ redacted: s }) })) }));
import { runAgent } from '@bedrock/shared';
import {
    jdRetrievalQueries,
    formatJdExtraction,
    JdExtractionSchema,
    type JdExtraction,
    extractJdSignal,
    extractJobDescription,
} from './jd-extractor.js';
import type { JdSignal } from '@bedrock/shared';

const mockRun = runAgent as jest.Mock;

const JD: JdExtraction = {
    requiredSkills:    ['Kubernetes', 'IAM'],
    preferredSkills:   ['ArgoCD'],
    tools:             ['AWS', 'Terraform'],
    concepts:          ['incident response'],
    responsibilities:  ['operate production infra'],
    domain:            'Cloud/DevOps',
    seniority:         'senior',
    retrievalKeywords: ['kubernetes', 'iam', 'terraform'],
};

describe('jdRetrievalQueries', () => {
    it('builds a skill query from skills + tools + keywords, deduped', () => {
        const q = jdRetrievalQueries(JD);
        expect(q.skill).toContain('Kubernetes');
        expect(q.skill).toContain('Terraform');
        // 'kubernetes' (keyword) and 'Kubernetes' (skill) are distinct tokens; dedupe is exact-string.
        expect(q.skill.split(' ').filter((t) => t === 'AWS')).toHaveLength(1);
    });
    it('builds experience + project queries with their anchor phrases', () => {
        const q = jdRetrievalQueries(JD);
        expect(q.experience).toContain('professional experience');
        expect(q.experience).toContain('operate production infra');
        expect(q.project).toContain('portfolio project');
        expect(q.project).toContain('Terraform');
    });
    it('never returns an empty skill query — a truncated/minimal extraction must still embed', () => {
        // A truncated JD extraction (stopReason=max_tokens) falls open to an
        // all-empty JdSignal. An empty skill query was sent to Bedrock Titan and
        // crashed the pipeline with "minLength: 1, actual: 0". The skill query
        // must always be non-empty so the embedding call is valid.
        const empty = JdExtractionSchema.parse({});
        const q = jdRetrievalQueries(empty);
        expect(q.skill.trim().length).toBeGreaterThan(0);
        expect(q.experience).toContain('professional experience');
        expect(q.project).toContain('portfolio project');
    });
});

describe('formatJdExtraction', () => {
    it('renders domain, seniority, and the skill/tool lists', () => {
        const out = formatJdExtraction(JD);
        expect(out).toContain('EXTRACTED JD SIGNAL');
        expect(out).toContain('Domain: Cloud/DevOps');
        expect(out).toContain('Required skills: Kubernetes, IAM');
        expect(out).toContain('Tools: AWS, Terraform');
    });
    it('omits empty lines', () => {
        const out = formatJdExtraction(JdExtractionSchema.parse({ requiredSkills: ['Go'] }));
        expect(out).toContain('Required skills: Go');
        expect(out).not.toContain('Preferred skills');
        expect(out).not.toContain('Domain:');
    });
});

describe('JdExtractionSchema', () => {
    it('defaults all fields so a partial model payload is safe', () => {
        const parsed = JdExtractionSchema.parse({ requiredSkills: ['Rust'] });
        expect(parsed).toEqual({
            // New JdSignal fields
            targetRole:           '',
            companyProblem:       '',
            dimensionMix:         { customerFacing: 0, technical: 0, aiMl: 0, supportOps: 0, monitoring: 0 },
            hardRequirements:     [],
            softRequirements:     [],
            implicitRequirements: [],
            technologyInventory:  { languages: [], frameworks: [], infrastructure: [], tools: [], methodologies: [] },
            experienceSignals:    { yearsExpected: '', domainExperience: '', leadershipExpectation: '', scaleIndicators: '' },
            // Existing atomic fields
            requiredSkills: ['Rust'], preferredSkills: [], tools: [], concepts: [],
            responsibilities: [], domain: '', seniority: '', retrievalKeywords: [],
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractJdSignal — full JdSignal tests
// ─────────────────────────────────────────────────────────────────────────────

const FULL_JD_SIGNAL: JdSignal = {
    targetRole:           'Senior Platform Engineer',
    seniority:            'senior',
    domain:               'Cloud/DevOps',
    companyProblem:       'Scale reliable platform delivery as the team grows.',
    dimensionMix:         { customerFacing: 0, technical: 70, aiMl: 0, supportOps: 20, monitoring: 10 },
    hardRequirements:     [{ skill: 'Kubernetes', context: '5+ years production', disqualifying: true }],
    softRequirements:     [{ skill: 'ArgoCD', context: 'nice-to-have' }],
    implicitRequirements: ['incident-response mindset'],
    technologyInventory:  {
        languages:      ['Python', 'Go'],
        frameworks:     [],
        infrastructure: ['AWS', 'Terraform'],
        tools:          ['Kubernetes', 'Helm'],
        methodologies:  ['GitOps'],
    },
    experienceSignals: {
        yearsExpected:        '5+',
        domainExperience:     'cloud infrastructure',
        leadershipExpectation: 'tech lead',
        scaleIndicators:      '500k+ users',
    },
    requiredSkills:    ['Kubernetes', 'IAM'],
    preferredSkills:   ['ArgoCD'],
    tools:             ['AWS', 'Terraform', 'Kubernetes'],
    concepts:          ['incident response', 'multi-account governance'],
    responsibilities:  ['operate production infra', 'on-call rotation'],
    retrievalKeywords: ['kubernetes', 'iam', 'terraform', 'gitops'],
};

describe('extractJdSignal', () => {
    beforeEach(() => {
        mockRun.mockReset();
    });

    it('returns a full JdSignal with all new fields from a successful Bedrock response', async () => {
        mockRun.mockResolvedValue({ data: FULL_JD_SIGNAL });

        const result = await extractJdSignal('Senior Platform Engineer at Acme — 5+ years Kubernetes required.');
        expect(result).not.toBeNull();

        // targetRole
        expect(result!.targetRole).toBe('Senior Platform Engineer');
        // companyProblem — the synthesized "why this role exists"
        expect(result!.companyProblem).toBe('Scale reliable platform delivery as the team grows.');

        // hardRequirements — array of {skill, context, disqualifying}
        expect(result!.hardRequirements).toHaveLength(1);
        expect(result!.hardRequirements[0]).toMatchObject({ skill: 'Kubernetes', disqualifying: true });

        // softRequirements
        expect(result!.softRequirements).toHaveLength(1);
        expect(result!.softRequirements[0].skill).toBe('ArgoCD');

        // implicitRequirements
        expect(result!.implicitRequirements).toContain('incident-response mindset');

        // technologyInventory
        expect(result!.technologyInventory.tools).toContain('Kubernetes');
        expect(result!.technologyInventory.languages).toContain('Python');
        expect(result!.technologyInventory.methodologies).toContain('GitOps');
        expect(result!.technologyInventory.infrastructure).toContain('Terraform');

        // experienceSignals
        expect(result!.experienceSignals.yearsExpected).toBe('5+');
        expect(result!.experienceSignals.leadershipExpectation).toBe('tech lead');

        // dimensionMix
        expect(result!.dimensionMix).toEqual({ customerFacing: 0, technical: 70, aiMl: 0, supportOps: 20, monitoring: 10 });

        // existing atomic fields preserved
        expect(result!.requiredSkills).toContain('Kubernetes');
        expect(result!.tools).toContain('AWS');
        expect(result!.retrievalKeywords).toContain('kubernetes');
    });

    it('fail-open: returns a minimal valid JdSignal (empty arrays/strings) on Bedrock error', async () => {
        mockRun.mockRejectedValue(new Error('bedrock timeout'));

        const result = await extractJdSignal('any job description text');
        expect(result).not.toBeNull();

        // All new fields must be present and empty/default
        expect(result!.targetRole).toBe('');
        expect(result!.dimensionMix).toEqual({ customerFacing: 0, technical: 0, aiMl: 0, supportOps: 0, monitoring: 0 });
        expect(result!.hardRequirements).toEqual([]);
        expect(result!.softRequirements).toEqual([]);
        expect(result!.implicitRequirements).toEqual([]);
        expect(result!.technologyInventory).toEqual({
            languages: [], frameworks: [], infrastructure: [], tools: [], methodologies: [],
        });
        expect(result!.experienceSignals).toEqual({
            yearsExpected: '', domainExperience: '', leadershipExpectation: '', scaleIndicators: '',
        });
        // Existing atomic fields also default
        expect(result!.requiredSkills).toEqual([]);
        expect(result!.retrievalKeywords).toEqual([]);
    });

    it('fail-open: returns a minimal valid JdSignal on unparseable (schema-invalid) output', async () => {
        mockRun.mockResolvedValue({ data: { invalidKey: true } });

        // runAgent's parseResponse will throw because the JSON is invalid when parsed by our schema
        // We simulate this by having the inner parseResponse reject
        mockRun.mockImplementation(({ parseResponse }: { parseResponse: (s: string) => unknown }) => {
            parseResponse(JSON.stringify({ invalidKey: true }));
            return Promise.resolve({ data: { invalidKey: true } });
        });

        // parseResponse with safeParse should still succeed (schema has all-default fields),
        // but we confirm the result is a valid minimal JdSignal
        const result = await extractJdSignal('some jd');
        expect(result).not.toBeNull();
        expect(Array.isArray(result!.requiredSkills)).toBe(true);
        expect(Array.isArray(result!.hardRequirements)).toBe(true);
    });

    it('back-compat alias extractJobDescription still resolves (returns same shape)', async () => {
        mockRun.mockResolvedValue({ data: FULL_JD_SIGNAL });
        const result = await extractJobDescription('Senior Platform Engineer job');
        expect(result).not.toBeNull();
        expect(result!.requiredSkills).toContain('Kubernetes');
        expect(result!.targetRole).toBe('Senior Platform Engineer');
    });
});
