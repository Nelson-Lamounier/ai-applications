/**
 * @format
 * Strategist Research Agent — JSON extraction + PII redaction.
 *
 * The former defensive-default behaviour (silently filling missing
 * nested objects with empty arrays / placeholder strings) has been
 * replaced by forced tool_use + a strict Zod safety-net that fails
 * fast on malformed output. Schema-validation behaviour is covered in
 * research-agent-validation.test.ts; this file covers the
 * parseJsonResponse unwrap utility and PII redaction before retrieval
 * and Bedrock.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { parseJsonResponse } from '../../../../shared/src/agent-runner';

// =============================================================================
// TEST CONSTANTS
// =============================================================================

/** Simulates a COMPLETE LLM response with all fields present */
const COMPLETE_RESEARCH_JSON = JSON.stringify({
    targetRole: 'Senior DevOps Engineer',
    targetCompany: 'Acme Corp',
    seniority: 'senior',
    domain: 'cloud-infrastructure',
    overallFitRating: 'STRONG',
    fitSummary: 'Strong alignment between candidate and role.',
    hardRequirements: [{ skill: 'Kubernetes', context: 'Production K8s required', disqualifying: false }],
    softRequirements: [{ skill: 'Terraform', context: 'Nice to have' }],
    implicitRequirements: ['Team leadership'],
    verifiedMatches: [{
        skill: 'Kubernetes',
        depth: 'production',
        sourceCitation: 'portfolio/k8s-cluster',
        recency: '2026',
    }],
    partialMatches: [{
        skill: 'Terraform',
        gapDescription: 'Uses CDK instead',
        transferableFoundation: 'IaC expertise with CDK',
        framingSuggestion: 'Highlight CDK as modern IaC',
    }],
    gaps: [{ skill: 'Go', gapType: 'language', impactSeverity: 'low', disqualifyingAssessment: 'Not critical' }],
    technologyInventory: {
        languages: ['TypeScript', 'Python'],
        frameworks: ['CDK', 'Next.js'],
        infrastructure: ['AWS', 'Kubernetes'],
        tools: ['GitHub Actions', 'ArgoCD'],
        methodologies: ['GitOps', 'IaC'],
    },
    experienceSignals: {
        yearsExpected: '3-5',
        domainExperience: 'cloud-native',
        leadershipExpectation: 'team lead',
        scaleIndicators: 'startup to mid-size',
    },
});

/** Simulates an INCOMPLETE LLM response — missing technologyInventory and other nested objects */
const INCOMPLETE_RESEARCH_JSON = JSON.stringify({
    targetRole: 'DevOps Engineer',
    targetCompany: 'Unknown Corp',
    seniority: 'mid',
    domain: 'cloud',
    overallFitRating: 'STRETCH',
    fitSummary: 'Limited data for assessment.',
    hardRequirements: [],
    softRequirements: [],
    implicitRequirements: [],
    verifiedMatches: [],
    partialMatches: [],
    gaps: [],
    // MISSING: technologyInventory — this is what causes the [0] crash
    // MISSING: experienceSignals
});

/** Simulates LLM wrapping JSON in markdown code block */
const WRAPPED_RESEARCH_JSON = `Here is my analysis:

\`\`\`json
${INCOMPLETE_RESEARCH_JSON}
\`\`\`

I hope this helps.`;

// =============================================================================
// HELPER: Simulate parseResponse callback from research-agent.ts
// =============================================================================

describe('parseJsonResponse', () => {
    it('should parse a complete JSON response correctly', () => {
        const result = parseJsonResponse<Record<string, unknown>>(COMPLETE_RESEARCH_JSON, 'test');
        expect(result.targetRole).toBe('Senior DevOps Engineer');
        expect(result.technologyInventory).toBeDefined();
    });

    it('should extract JSON from markdown-wrapped response', () => {
        const result = parseJsonResponse<Record<string, unknown>>(WRAPPED_RESEARCH_JSON, 'test');
        expect(result.targetRole).toBe('DevOps Engineer');
    });

    it('should throw on response with no JSON', () => {
        expect(() => parseJsonResponse('No JSON here', 'test')).toThrow('No JSON object found');
    });
});

// =============================================================================
// PII REDACTION — executeResearchAgent integration (mocked infra)
// =============================================================================

/**
 * Minimal stub for the AgentResult shape returned by runAgent.
 * Only the fields used by executeResearchAgent's parseResponse are present.
 */
// ResearchMatching shape — JD fields are no longer produced by this agent.
const STUB_AGENT_RESULT = {
    data: {
        overallFitRating: 'STRONG FIT' as const,
        fitSummary: 'Good fit.',
        verifiedMatches: [],
        partialMatches: [],
        gaps: [],
        resumeData: null,
        kbContext: '',
        resumeConstraints: '',
    },
    usage: { input: 10, output: 10, thinking: 0 },
    costUsd: 0.001,
    durationMs: 100,
    agentName: 'strategist-research' as const,
};

/**
 * Captured call data returned by runResearchAgentForTest.
 * queryArgs: all queryText values passed to store.querySimilar across the 4 parallel calls.
 * bedrockUserMessage: the userMessage passed to runAgent.
 */
interface CapturedCallData {
    queryArgs: string[];
    bedrockUserMessage: string;
}

/**
 * Drives executeResearchAgent with mocked infra and returns captured call data.
 * Uses jest.isolateModules so the module re-executes with env + mocks in place.
 */
async function runResearchAgentForTest(jd: string): Promise<CapturedCallData> {
    const capturedQueryTexts: string[] = [];
    let capturedUserMessage = '';

    // Mock querySimilar — returns empty results (no KB passages) so kbContext is empty string.
    const mockQuerySimilar = jest.fn().mockResolvedValue([]);

    // Mock embed — returns a zero-vector (embedding value not checked by test).
    const mockEmbed = jest.fn().mockResolvedValue(new Array(1024).fill(0));

    // Mock runAgent — captures userMessage and returns stub result.
    // parseResponse is invoked inside runAgent in production; here we bypass it
    // by having runAgent return the stub directly.
    const mockRunAgent = jest.fn().mockImplementation(
        async (opts: { userMessage: string; parseResponse?: (text: string) => any }) => {
            capturedUserMessage = opts.userMessage;
            // Invoke the parseResponse with a ResearchMatching-shaped JSON.
            // JD fields are no longer produced by the research model (Task 4).
            const parsed = opts.parseResponse?.(JSON.stringify({
                overallFitRating: 'STRONG FIT',
                fitSummary: 'Good fit.',
                assessments: [],
            }));
            return { ...STUB_AGENT_RESULT, data: parsed ?? STUB_AGENT_RESULT.data };
        },
    );

    let executeResearchAgent!: (ctx: any) => Promise<any>;

    jest.isolateModules(() => {
        // Set required env before the module executes.
        process.env['RESEARCH_MODEL'] = 'eu.anthropic.claude-haiku-4-5-20251001-v1:0';
        process.env['RERANKER_DISABLED'] = '1'; // Disable reranker to simplify mock surface.

        // Mock @bedrock/shared — keep real PiiScrubber + InputSanitiser; stub infra.
        jest.mock('@bedrock/shared', () => {
            const actual = jest.requireActual<Record<string, unknown>>('@bedrock/shared');
            return {
                ...actual,
                runAgent:     mockRunAgent,
                log:          jest.fn(),
                TitanEmbeddingProvider: {
                    fromEnvironment: jest.fn().mockReturnValue({ embed: mockEmbed }),
                },
                BedrockReranker: {
                    fromEnvironment: jest.fn().mockReturnValue(null),
                },
                RdsVectorStore: {
                    fromEnvironment: jest.fn().mockReturnValue({ querySimilar: mockQuerySimilar }),
                },
                RdsExperienceVectorStore: {
                    fromEnvironment: jest.fn().mockReturnValue({ querySimilar: mockQuerySimilar }),
                },
            };
        });

        // Mock sub-dependencies that research-agent imports transitively.
        jest.mock('../../services/resume-service.js', () => ({
            formatResumeForPrompt: jest.fn().mockReturnValue(''),
        }));
        jest.mock('../../prompts/research-persona.js', () => ({
            RESEARCH_PERSONA_SYSTEM_PROMPT: 'stub-system-prompt',
            RESEARCH_PERSONA_META: { id: 'research-persona', version: '1', cachePoint: 'default' },
        }));
        jest.mock('../../prompts/resume-constraints.js', () => ({
            RESUME_CONSTRAINTS: '',
        }));

        // Dynamically require to pick up mocks + env.
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock hoisting requires runtime require here
        ({ executeResearchAgent } = require('./research-agent'));
    });

    await executeResearchAgent({
        pipelineId: 'test-pipeline-001',
        userId: 'user-test-0001',
        targetRole: 'Senior Engineer',
        jobDescription: jd,
        resumeData: null,
        environment: 'test',
        cumulativeTokens: { input: 0, output: 0, thinking: 0 },
        cumulativeCostUsd: 0,
    });

    // Collect queryText from all querySimilar calls.
    for (const call of mockQuerySimilar.mock.calls) {
        const params = call[0] as { queryText?: string };
        if (params.queryText) {
            capturedQueryTexts.push(params.queryText);
        }
    }

    return {
        queryArgs: capturedQueryTexts,
        bedrockUserMessage: capturedUserMessage,
    };
}

describe('Strategist Research Agent — PII redaction before retrieval and Bedrock', () => {
    it('redacts PII from the job description before retrieval and Bedrock', async () => {
        const jd = 'Contact recruiter@acme.com or 415-555-2671. Senior role: AWS, TypeScript, Kubernetes across teams, 5+ years.';
        const captured = await runResearchAgentForTest(jd);

        const queryText = captured.queryArgs.join(' ');

        // Retrieval queries must NOT contain raw PII — and the scrub fired (tokens present).
        expect(queryText).not.toContain('recruiter@acme.com');
        expect(queryText).not.toContain('415-555-2671');
        expect(queryText).toContain('[EMAIL]');
        expect(queryText).toContain('[PHONE]');

        // Single-read contract: the matcher prompt no longer embeds the raw JD at all,
        // so no JD content (PII or otherwise) reaches Bedrock via the prompt.
        expect(captured.bedrockUserMessage).not.toContain('recruiter@acme.com');
        expect(captured.bedrockUserMessage).not.toContain('415-555-2671');
        expect(captured.bedrockUserMessage).not.toContain('Contact recruiter');
    });
});
