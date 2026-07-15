/** @format */
jest.mock('@bedrock/shared', () => ({
    ...jest.requireActual('@bedrock/shared'),
    runAgent: jest.fn(),
}));
import { runAgent } from '@bedrock/shared';
import type { StrategistResearchResult } from '@bedrock/shared';
import { executeAnalysisAgent, parseAnalysisResponse } from '../analysis-agent.js';
import type { AnalysisMessageInput } from '../analysis-message.js';

const mockRun = runAgent as jest.Mock;

const baseResearch = (): StrategistResearchResult => ({
    targetRole: 'Site Reliability Engineer',
    targetCompany: 'Acme Corp',
    seniority: 'Senior',
    domain: 'Platform Engineering',
    companyProblem: '',
    dimensionMix: { customerFacing: 0, technical: 100, aiMl: 0, supportOps: 0, monitoring: 0 },
    hardRequirements: [],
    softRequirements: [],
    implicitRequirements: [],
    technologyInventory: { languages: [], frameworks: [], infrastructure: [], tools: [], methodologies: [] },
    verifiedMatches: [],
    partialMatches: [],
    gaps: [],
    overallFitRating: 'STRONG FIT',
    fitSummary: 'Strong platform alignment.',
    resumeConstraints: '',
} as unknown as StrategistResearchResult);

const baseInput = (): AnalysisMessageInput => ({
    research: baseResearch(),
    codeStack: '',
    yearsGapFraming: '',
});

const baseCtx = {
    pipelineId: 'p',
    environment: 'test',
    cumulativeTokens: { input: 0, output: 0, thinking: 0 },
    cumulativeCostUsd: 0,
} as unknown as Parameters<typeof executeAnalysisAgent>[0];

const FIXTURE_XML = `
<job_application_analysis>
  <phase_0_archetype_selection>
    <selected_archetype>Site Reliability Engineer (SRE)</selected_archetype>
    <archetype_id>2</archetype_id>
    <trigger_phrases_matched>
      <phrase>on-call</phrase>
      <phrase>MTTR</phrase>
    </trigger_phrases_matched>
    <excluded_content_categories>
      <category>frontend frameworks</category>
    </excluded_content_categories>
    <lead_identity><![CDATA[SRE focused on reliability and incident response.]]></lead_identity>
    <confidence_score>0.9</confidence_score>
    <archetype_gap_detected>false</archetype_gap_detected>
  </phase_0_archetype_selection>
  <metadata>
    <candidate_name>Jane Doe</candidate_name>
    <target_role>Site Reliability Engineer</target_role>
    <target_company>Acme Corp</target_company>
    <analysis_date>2026-07-15</analysis_date>
    <overall_fit_rating>STRONG FIT</overall_fit_rating>
    <application_recommendation>APPLY</application_recommendation>
  </metadata>
  <phase_3_strategy>
    <gap_mitigation>
      <mitigation><gap>Ansible</gap><honest_framing>No Ansible experience; config management achieved via AWS CDK TypeScript</honest_framing><bridge_narrative>Declarative infrastructure automation daily, different tool</bridge_narrative><proactive_action>Work through an Ansible playbook conversion</proactive_action><go_no_go>go</go_no_go></mitigation>
    </gap_mitigation>
  </phase_3_strategy>
</job_application_analysis>
`;

describe('parseAnalysisResponse', () => {
    it('extracts archetype selection, gap mitigations, and metadata from a fixture XML', () => {
        const result = parseAnalysisResponse(FIXTURE_XML);

        expect(result.analysisXml.length).toBeGreaterThan(0);
        expect(result.metadata).toEqual({
            candidateName: 'Jane Doe',
            targetRole: 'Site Reliability Engineer',
            targetCompany: 'Acme Corp',
            analysisDate: '2026-07-15',
            overallFitRating: 'STRONG FIT',
            applicationRecommendation: 'APPLY',
        });
        expect(result.archetypeSelection).toEqual({
            selectedArchetype: 'Site Reliability Engineer (SRE)',
            archetypeId: 2,
            triggerPhrasesMatched: ['on-call', 'MTTR'],
            excludedContentCategories: ['frontend frameworks'],
            leadIdentity: 'SRE focused on reliability and incident response.',
            confidenceScore: 0.9,
            archetypeGapDetected: false,
        });
        expect(result.gapMitigations).toHaveLength(1);
        expect(result.gapMitigations[0]).toEqual({
            gap: 'Ansible',
            honestFraming: 'No Ansible experience; config management achieved via AWS CDK TypeScript',
            bridgeNarrative: 'Declarative infrastructure automation daily, different tool',
            proactiveAction: 'Work through an Ansible playbook conversion',
            goNoGo: 'go',
        });
    });

    it('stubs the deprecated resume/cover-letter fields -- owned by dedicated passes', () => {
        const result = parseAnalysisResponse(FIXTURE_XML);

        expect(result.coverLetter).toBeNull();
        expect(result.tailoredResumeData).toBeNull();
        expect(result.resumeSuggestions).toEqual({ additions: [], reframes: [], eslCorrections: [] });
        expect(result.resumeAdditions).toBe(0);
        expect(result.resumeReframes).toBe(0);
        expect(result.eslCorrections).toBe(0);
    });

    it('throws on an empty analysisXml -- load-bearing for the cache-hit gate', () => {
        expect(() => parseAnalysisResponse('')).toThrow();
    });

    it('throws on a blank (whitespace-only) analysisXml', () => {
        expect(() => parseAnalysisResponse('   \n\t  ')).toThrow();
    });
});

describe('executeAnalysisAgent', () => {
    beforeEach(() => { mockRun.mockReset(); });

    it('sends a no-tool config (thinkingBudget 2048, Sonnet, no forced tool) and the built user message', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(FIXTURE_XML),
        }));

        await executeAnalysisAgent(baseCtx, baseInput());

        expect(mockRun).toHaveBeenCalledTimes(1);
        const call = mockRun.mock.calls[0]![0] as {
            userMessage: string;
            config: { agentName: string; tool?: unknown; thinkingBudget: number; maxTokens: number; modelId: string };
        };
        expect(call.config.agentName).toBe('strategist-analysis');
        expect(call.config.tool).toBeUndefined();
        expect(call.config.thinkingBudget).toBe(2048);
        expect(call.config.maxTokens).toBe(8000);
        expect(call.config.modelId).not.toMatch(/haiku/i);
        expect(call.userMessage).toContain('Site Reliability Engineer');
    });

    it('parses a valid response via parseAnalysisResponse (real parsing pipeline)', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(FIXTURE_XML),
        }));

        const res = await executeAnalysisAgent(baseCtx, baseInput());

        expect(res.data.archetypeSelection?.selectedArchetype).toBe('Site Reliability Engineer (SRE)');
        expect(res.data.gapMitigations).toHaveLength(1);
        expect(res.data.coverLetter).toBeNull();
        expect(res.data.tailoredResumeData).toBeNull();
    });

    it('rejects when the response sanitises to an empty analysisXml', async () => {
        mockRun.mockImplementation(async (opts: { parseResponse: (text: string) => unknown }) => ({
            data: opts.parseResponse(''),
        }));

        await expect(executeAnalysisAgent(baseCtx, baseInput())).rejects.toThrow();
    });
});
