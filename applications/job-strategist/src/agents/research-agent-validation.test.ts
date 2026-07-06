/**
 * @format
 * Strategist Research Agent — schema validation safety-net tests.
 */

// research-agent.ts throws at module load if RESEARCH_MODEL is unset (CDK
// contract). Set it before the dynamic import.
import type { validateResearchResult as ValidateResearchResultFn, executeResearchAgent as ExecuteResearchAgentFn } from './research-agent.js';
import type { JdSignal } from '@bedrock/shared';

process.env['RESEARCH_MODEL'] = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';

let validateResearchResult: typeof ValidateResearchResultFn;

beforeAll(async () => {
    ({ validateResearchResult } = await import('./research-agent.js'));
});

// After Task 4: VALID contains only matching fields (ResearchMatching shape).
// JD fields (targetRole, seniority, domain, hardRequirements, etc.) are no
// longer produced by the research model — they come from JdSignal.
const VALID = {
    assessments: [
        { skill: 'K8s', verdict: 'verified', sourceCitation: 'self-healing', depth: 'expert', recency: '2026' },
        { skill: 'TF', verdict: 'partial', gapDescription: 'uses CDK', transferableFoundation: 'IaC', framingSuggestion: 'frame CDK' },
        { skill: 'Go', verdict: 'gap', gapType: 'hard', impactSeverity: 'minor', disqualifyingAssessment: 'not blocking' },
    ],
    overallFitRating: 'STRONG FIT',
    fitSummary: 'Strong alignment.',
};

const INJECTED = { resumeData: null, kbContext: 'ctx', resumeConstraints: 'rules' };

const VALID_DSA_CALIBRATION = {
    likelyTopics: [
        {
            canonicalName: 'arrays-strings',
            displayName: 'Arrays & Strings',
            confidence: 0.85,
            rationale: 'JD requires in-place array manipulation problems',
            jdEvidenceQuote: 'solve complex array manipulation problems',
        },
    ],
    honestyNote: 'These topics are inferred from JD language and signals — not confirmed interview format. Verify with recruiter.',
};

describe('validateResearchResult', () => {
    it('returns a typed result merged with injected (non-model) fields', () => {
        const r = validateResearchResult(VALID, INJECTED);
        expect(r.verifiedMatches).toHaveLength(1);
        expect(r.kbContext).toBe('ctx');
        expect(r.resumeConstraints).toBe('rules');
        expect(r.resumeData).toBeNull();
    });

    it('throws fast when a required model field is missing', () => {
        const { fitSummary: _fitSummary, ...broken } = VALID;
        expect(() => validateResearchResult(broken, INJECTED)).toThrow(/schema validation/i);
    });

    it('throws fast when the model injects an unknown field', () => {
        expect(() => validateResearchResult({ ...VALID, injected: 'nope' }, INJECTED))
            .toThrow(/schema validation/i);
    });

    it('rejects an invalid enum (overallFitRating)', () => {
        expect(() => validateResearchResult({ ...VALID, overallFitRating: 'MAYBE' }, INJECTED))
            .toThrow(/schema validation/i);
    });

    it('validates and passes through dsaTopicCalibration when present', () => {
        const r = validateResearchResult({ ...VALID, dsaTopicCalibration: VALID_DSA_CALIBRATION }, INJECTED);
        expect(r.dsaTopicCalibration).toBeDefined();
        expect(r.dsaTopicCalibration!.likelyTopics).toHaveLength(1);
        expect(r.dsaTopicCalibration!.likelyTopics[0]!.canonicalName).toBe('arrays-strings');
        expect(r.dsaTopicCalibration!.likelyTopics[0]!.confidence).toBe(0.85);
        expect(r.dsaTopicCalibration!.honestyNote).toMatch(/inferred/i);
    });

    it('validates without dsaTopicCalibration (field is optional)', () => {
        const r = validateResearchResult(VALID, INJECTED);
        expect(r.dsaTopicCalibration).toBeUndefined();
    });

    it('rejects dsaTopicCalibration with a missing required topic sub-field', () => {
        const broken = {
            ...VALID,
            dsaTopicCalibration: {
                likelyTopics: [{ canonicalName: 'arrays-strings', displayName: 'Arrays & Strings', confidence: 0.9, rationale: 'test' }],
                // missing jdEvidenceQuote
                honestyNote: 'note',
            },
        };
        expect(() => validateResearchResult(broken, INJECTED)).toThrow(/schema validation/i);
    });

    it('rejects dsaTopicCalibration missing honestyNote', () => {
        const broken = {
            ...VALID,
            dsaTopicCalibration: {
                likelyTopics: [],
                // missing honestyNote
            },
        };
        expect(() => validateResearchResult(broken, INJECTED)).toThrow(/schema validation/i);
    });
});

// =============================================================================
// pillarClassification — optional field tests (S2)
// =============================================================================

const BASE = {
    assessments: [],
    overallFitRating: 'STRONG FIT', fitSummary: 'ok',
};
const INJECTED_BASE = { resumeData: null, kbContext: '', resumeConstraints: '' };

describe('validateResearchResult — pillarClassification (optional)', () => {
    it('accepts a brief WITHOUT pillarClassification (optional)', () => {
        const r = validateResearchResult(BASE, INJECTED_BASE);
        expect(r.pillarClassification).toBeUndefined();
    });

    it('passes pillarClassification through when present', () => {
        const r = validateResearchResult({
            ...BASE,
            pillarClassification: {
                primaryPillar: 'devops-sre-platform', secondaryPillars: ['ai-engineering'],
                confidence: 0.8, jdEvidenceTokens: ['on-call rotation', 'Kubernetes'], classificationNote: 'inferred from JD',
            },
        }, INJECTED_BASE);
        expect(r.pillarClassification?.primaryPillar).toBe('devops-sre-platform');
        expect(r.pillarClassification?.secondaryPillars).toEqual(['ai-engineering']);
    });

    it('rejects an invalid primaryPillar enum', () => {
        expect(() => validateResearchResult({
            ...BASE,
            pillarClassification: { primaryPillar: 'wizardry', secondaryPillars: [], confidence: 1, jdEvidenceTokens: [], classificationNote: 'x' },
        }, INJECTED_BASE)).toThrow(/schema validation/);
    });
});

// =============================================================================
// executeResearchAgent KB-matcher contract
// =============================================================================

describe('executeResearchAgent KB-matcher contract', () => {
    it('accepts jdSignal and returns only ResearchMatching fields', async () => {
        // A ResearchMatching-shaped tool response — no JD fields.
        const MATCHING_RESPONSE = {
            assessments: [
                { skill: 'K8s', verdict: 'verified', sourceCitation: 'ai-applications/k8s-setup', depth: 'expert', recency: '2026' },
                { skill: 'Terraform', verdict: 'partial', gapDescription: 'uses CDK instead', transferableFoundation: 'IaC expertise', framingSuggestion: 'frame CDK as modern IaC' },
                { skill: 'Go', verdict: 'gap', gapType: 'hard', impactSeverity: 'minor', disqualifyingAssessment: 'not blocking' },
            ],
            overallFitRating: 'STRONG FIT',
            fitSummary: 'Strong match against given JD signal.',
        };

        const jdSignal: JdSignal = {
            targetRole: 'Senior SRE',
            seniority: 'senior',
            domain: 'devops-sre-platform',
            companyProblem: 'Keep production reliable at scale.',
            dimensionMix: { customerFacing: 0, technical: 50, aiMl: 0, supportOps: 30, monitoring: 20 },
            hardRequirements: [{ skill: 'Kubernetes', context: '5y prod', disqualifying: true }],
            softRequirements: [{ skill: 'Mentoring', context: 'team lead' }],
            implicitRequirements: ['on-call'],
            technologyInventory: { languages: ['Go'], frameworks: ['CDK'], infrastructure: ['AWS'], tools: ['ArgoCD'], methodologies: ['GitOps'] },
            experienceSignals: { yearsExpected: '5+', domainExperience: 'cloud-native', leadershipExpectation: 'team lead', scaleIndicators: '100k+' },
            requiredSkills: ['Kubernetes', 'AWS'],
            preferredSkills: ['Go'],
            tools: ['ArgoCD'],
            concepts: ['GitOps', 'SRE'],
            responsibilities: ['on-call rotation', 'incident response'],
            retrievalKeywords: ['kubernetes', 'aws', 'sre', 'gitops'],
        };

        const mockRunAgent = jest.fn().mockImplementation(
            async (opts: { userMessage: string; parseResponse?: (text: string) => unknown }) => {
                const parsed = opts.parseResponse?.(JSON.stringify(MATCHING_RESPONSE));
                return {
                    data: parsed,
                    usage: { input: 10, output: 10, thinking: 0 },
                    costUsd: 0.001,
                    durationMs: 100,
                    agentName: 'strategist-research',
                };
            },
        );

        let executeResearchAgent!: typeof ExecuteResearchAgentFn;

        jest.isolateModules(() => {
            process.env['RESEARCH_MODEL'] = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
            process.env['RERANKER_DISABLED'] = '1';

            jest.mock('@bedrock/shared', () => {
                const actual = jest.requireActual<Record<string, unknown>>('@bedrock/shared');
                return {
                    ...actual,
                    runAgent: mockRunAgent,
                    log: jest.fn(),
                    TitanEmbeddingProvider: {
                        fromEnvironment: jest.fn().mockReturnValue({ embed: jest.fn().mockResolvedValue(new Array(1024).fill(0)) }),
                    },
                    BedrockReranker: { fromEnvironment: jest.fn().mockReturnValue(null) },
                    RdsVectorStore: { fromEnvironment: jest.fn().mockReturnValue({ querySimilar: jest.fn().mockResolvedValue([]) }) },
                    RdsExperienceVectorStore: { fromEnvironment: jest.fn().mockReturnValue({ querySimilar: jest.fn().mockResolvedValue([]) }) },
                };
            });

            jest.mock('../services/resume-service.js', () => ({
                formatResumeForPrompt: jest.fn().mockReturnValue(''),
            }));
            jest.mock('../prompts/research-persona.js', () => ({
                RESEARCH_PERSONA_SYSTEM_PROMPT: 'stub-system-prompt',
                RESEARCH_PERSONA_META: { id: 'research-persona', version: '1', cachePoint: 'default' },
            }));
            jest.mock('../prompts/resume-constraints.js', () => ({
                RESUME_CONSTRAINTS: '',
            }));

            // eslint-disable-next-line @typescript-eslint/no-require-imports
            ({ executeResearchAgent } = require('./research-agent'));
        });

        const ctx = {
            pipelineId: 'test-pipeline-002',
            userId: 'user-test-0002',
            operation: 'analyse' as const,
            applicationSlug: 'acme-senior-sre-test',
            targetRole: 'Senior SRE',
            targetCompany: 'Acme',
            jobDescription: 'Senior SRE role requiring Kubernetes, AWS, and on-call rotation. 5+ years experience.',
            resumeId: 'resume-test-001',
            resumeData: null,
            interviewStage: 'applied' as const,
            bucket: 'test-bucket',
            environment: 'test',
            startedAt: new Date().toISOString(),
            cumulativeTokens: { input: 0, output: 0, thinking: 0 },
            cumulativeCostUsd: 0,
        };

        const result = await executeResearchAgent(ctx, undefined, '', '', jdSignal, null, '');

        // Must contain ResearchMatching fields.
        expect(result.data.verifiedMatches).toBeDefined();
        expect(result.data.partialMatches).toBeDefined();
        expect(result.data.gaps).toBeDefined();
        expect(result.data.overallFitRating).toBe('STRONG FIT');
        expect(result.data.fitSummary).toBeDefined();
        expect(result.data.resumeData).toBeNull();
        expect(result.data.kbContext).toBeDefined();

        // Must NOT have JD-extraction fields as own properties on result.data.
        expect(Object.hasOwn(result.data, 'hardRequirements')).toBe(false);
        expect(Object.hasOwn(result.data, 'technologyInventory')).toBe(false);
        expect(Object.hasOwn(result.data, 'experienceSignals')).toBe(false);
    });
});
